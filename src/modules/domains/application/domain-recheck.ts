import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobQueue } from '../../jobs/application/job-queue.service';
import type { JobContext } from '../../jobs/domain/job';
import {
  DOMAIN_RECHECK_SOURCE,
  type DomainRecheckSource,
  type VerifiedDomainRef,
} from '../domain/ports/domain-recheck-source.port';
import {
  TENANT_DOMAIN_REPOSITORY,
  type TenantDomainRepository,
} from '../domain/ports/tenant-domain-repository.port';
import {
  DNS_RESOLVER,
  DnsLookupError,
  type DnsResolver,
} from '../domain/ports/dns-resolver.port';
import {
  hasVerificationToken,
  isSuspectRound,
  nextCheckState,
  recheckRound,
  verificationRecordName,
} from '../domain/rules/tenant-domain-rules';
import {
  DOMAINS_CONFIG,
  type DomainsConfig,
} from '../infrastructure/domains-config';
import { DomainClock } from './domain-clock';

export const RECHECK_SWEEP_JOB = 'domains.recheck-sweep';
export const RECHECK_SWEEP_SCHEDULE = 'domains.recheck-sweep.hourly';
export const RECHECK_DOMAIN_JOB = 'domains.recheck';

const SWEEP_BATCH = 500;

/**
 * Resultado de la consulta DNS que el barrido ya hizo (DX-220): `found` (el
 * TXT con el token está) o `missing` (fallo definitivo). Sin él, el DNS no
 * respondió en el barrido y la comprobación lo consulta ella misma, con los
 * reintentos de la cola.
 */
export type RecheckResult = 'found' | 'missing';

/** Payload de una comprobación: solo ids, la ronda y el resultado (DX-085). */
export interface RecheckDomainPayload {
  [key: string]: string;
  domainId: string;
  /** Instante ISO de la ronda: la hora UTC (truncada) del barrido que la encoló. */
  round: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Consultas DNS a la vez durante el barrido. */
const SWEEP_DNS_CONCURRENCY = 16;

type Probe = RecheckResult | 'inconclusive';

/**
 * Barrido de la re-verificación (SEC-009; tarea programada horaria de DX-085,
 * un ejecutor por tick). La ronda es la hora UTC del barrido
 * (`recheckRound`): repetirlo en la misma hora no encola otra comprobación.
 *
 * DX-220 (OPS-033): antes de encolar nada consulta el TXT de TODOS los
 * dominios VERIFIED vivos de la ronda (con el resolver acotado,
 * NodeDnsResolver). Si más de la mitad fallan (sin el TXT o sin respuesta,
 * y son al menos 4, `isSuspectRound`), la ronda NO cuenta para ninguno: no encola nada y
 * deja `domains.recheck_suspect` en el log; lo probable es que falle el DNS
 * propio, no medio parque de clínicas a la vez. Si no, encola una
 * comprobación por dominio, en su clínica, con `idempotencyKey` por
 * (dominio, ronda) y el resultado ya consultado (`result`); los que no
 * respondieron van sin él y se consultan en su trabajo, con reintentos.
 */
@Injectable()
export class DomainRecheckSweep {
  private readonly logger = new Logger('Domains');

  constructor(
    @Inject(DOMAIN_RECHECK_SOURCE) private readonly source: DomainRecheckSource,
    private readonly jobs: JobQueue,
    private readonly clock: DomainClock,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
  ) {}

  /**
   * Devuelve cuántas comprobaciones encoló (nuevas o ya existentes): 0 si la
   * ronda es sospechosa. `signal` (la del trabajo) corta el barrido.
   */
  async run(signal?: AbortSignal): Promise<number> {
    const round = recheckRound(this.clock.now()).toISOString();
    const domains: VerifiedDomainRef[] = [];
    let afterHost: string | null = null;
    for (;;) {
      const batch = await this.source.listVerified(afterHost, SWEEP_BATCH);
      domains.push(...batch);
      if (batch.length < SWEEP_BATCH) break;
      afterHost = batch[batch.length - 1].host;
    }

    const probes = await this.probeAll(domains, signal);
    const missing = probes.filter((p) => p === 'missing').length;
    const inconclusive = probes.filter((p) => p === 'inconclusive').length;
    // Un timeout también es un fallo de la ronda (revisión DX-220): un DNS
    // propio medio roto mezcla timeouts con NXDOMAIN falsos, y contar solo
    // los definitivos dejaría pasar esos NXDOMAIN aunque falle casi todo.
    if (isSuspectRound(domains.length, missing + inconclusive)) {
      // Sin hosts ni tokens: la ronda y los contadores.
      this.logger.warn({
        event: 'domains.recheck_suspect',
        round,
        domains: domains.length,
        missing,
        inconclusive,
      });
      return 0;
    }
    signal?.throwIfAborted();
    for (const [i, domain] of domains.entries()) {
      const probe = probes[i];
      const payload: RecheckDomainPayload = {
        domainId: domain.id,
        round,
        ...(probe === 'inconclusive' ? {} : { result: probe }),
      };
      await this.jobs.enqueue(RECHECK_DOMAIN_JOB, payload, {
        tenantId: domain.tenantId,
        idempotencyKey: `domains.recheck:${domain.id}:${round}`,
      });
    }
    this.logger.log({
      event: 'domains.recheck_planned',
      planned: domains.length,
      missing,
      inconclusive,
    });
    return domains.length;
  }

  /** El TXT de cada dominio, como mucho SWEEP_DNS_CONCURRENCY a la vez. */
  private async probeAll(
    domains: VerifiedDomainRef[],
    signal?: AbortSignal,
  ): Promise<Probe[]> {
    const probes: Probe[] = new Array<Probe>(domains.length);
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < domains.length) {
        signal?.throwIfAborted();
        const i = next;
        next += 1;
        probes[i] = await this.probe(domains[i]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SWEEP_DNS_CONCURRENCY, domains.length) },
        lane,
      ),
    );
    return probes;
  }

  private async probe(domain: VerifiedDomainRef): Promise<Probe> {
    try {
      const records = await this.dns.resolveTxt(
        verificationRecordName(domain.host),
      );
      return hasVerificationToken(records, domain.verifyToken)
        ? 'found'
        : 'missing';
    } catch (error) {
      if (error instanceof DnsLookupError) return 'inconclusive';
      throw error;
    }
  }
}

/**
 * Una comprobación (corre con el tenant del dominio en el contexto). Usa el
 * resultado que ya consultó el barrido (`result`) o, si el DNS no respondió
 * entonces, lo consulta ella. Si el
 * TXT con el token sigue publicado, reinicia la cuenta de fallos; si no, suma
 * uno y al llegar a DOMAIN_RECHECK_MAX_FAILURES seguidos el dominio pasa a
 * DISABLED: deja de enrutar (TenantResolverService solo enruta VERIFIED) y la
 * clínica lo ve «Desactivado».
 *
 * Solo cuentan las respuestas definitivas: NXDOMAIN / NODATA o TXT sin el
 * token. Un DNS que no responde (SERVFAIL, timeout, conexión rechazada…) se
 * reintenta con el backoff de la cola y, si sigue sin responder en el último
 * intento, la ronda NO cuenta (decisión SEC-009): el token es público, así que
 * contar esos errores no protege de nada y desactivaría dominios legítimos (o
 * todos, si cae el resolver). Idempotente por ronda (la cola es «al menos una
 * vez»).
 */
@Injectable()
export class RecheckDomain {
  private readonly logger = new Logger('Domains');

  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(DOMAINS_CONFIG)
    private readonly config: Pick<DomainsConfig, 'recheckMaxFailures'>,
  ) {}

  async handle(
    payload: Record<string, unknown>,
    context: Pick<JobContext, 'attempt' | 'maxAttempts' | 'tenantId'>,
  ): Promise<void> {
    const { domainId, round: rawRound, result } = payload;
    const round = typeof rawRound === 'string' ? new Date(rawRound) : null;
    if (
      typeof domainId !== 'string' ||
      !UUID.test(domainId) ||
      !round ||
      Number.isNaN(round.getTime()) ||
      (result !== undefined && result !== 'found' && result !== 'missing')
    ) {
      throw new Error('domains.recheck: payload inválido');
    }
    const domain = await this.repo.findForRecheck(domainId, round);
    // Borrado, desactivado o ya comprobado en esta ronda: nada que hacer.
    if (!domain) return;

    let found: boolean;
    if (result !== undefined) {
      found = result === 'found';
    } else {
      try {
        const records = await this.dns.resolveTxt(
          verificationRecordName(domain.host),
        );
        found = hasVerificationToken(records, domain.verifyToken);
      } catch (error) {
        if (!(error instanceof DnsLookupError)) throw error;
        if (context.attempt < context.maxAttempts) throw error;
        // Sin respuesta definitiva: la ronda no cuenta (ni suma ni reinicia).
        this.logger.warn({
          event: 'domains.recheck_inconclusive',
          domainId: domain.id,
          tenantId: context.tenantId,
          code: error.code,
        });
        return;
      }
    }

    const next = nextCheckState(
      domain.failedChecks,
      found,
      this.config.recheckMaxFailures,
    );
    const saved = await this.repo.recordCheck({
      id: domain.id,
      round,
      expectedFailedChecks: domain.failedChecks,
      failedChecks: next.failedChecks,
      disable: next.disable,
    });
    if (!saved || found) return;
    // Sin datos del paciente ni el host: ids y la cuenta de fallos.
    const fields = {
      domainId: domain.id,
      tenantId: context.tenantId,
      failedChecks: saved.failedChecks,
      maxFailures: this.config.recheckMaxFailures,
    };
    if (saved.status === 'DISABLED') {
      this.logger.warn({ event: 'domains.disabled', ...fields });
    } else {
      this.logger.warn({ event: 'domains.recheck_failed', ...fields });
    }
  }
}
