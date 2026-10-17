import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobQueue } from '../../jobs/application/job-queue.service';
import type { JobContext } from '../../jobs/domain/job';
import {
  DOMAIN_RECHECK_SOURCE,
  type DomainRecheckSource,
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
  nextCheckState,
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

/** Payload de una comprobación: solo ids y la ronda (DX-085). */
export interface RecheckDomainPayload {
  [key: string]: string;
  domainId: string;
  /** Instante ISO de la ronda (el del barrido que la encoló). */
  round: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Barrido de la re-verificación (SEC-009; tarea programada horaria de DX-085,
 * un ejecutor por tick): encola una comprobación por dominio VERIFIED vivo,
 * en la clínica de ese dominio, con `idempotencyKey` por (dominio, ronda).
 */
@Injectable()
export class DomainRecheckSweep {
  private readonly logger = new Logger('Domains');

  constructor(
    @Inject(DOMAIN_RECHECK_SOURCE) private readonly source: DomainRecheckSource,
    private readonly jobs: JobQueue,
    private readonly clock: DomainClock,
  ) {}

  /** Devuelve cuántas comprobaciones encoló (nuevas o ya existentes). */
  async run(): Promise<number> {
    const round = this.clock.now().toISOString();
    let afterHost: string | null = null;
    let planned = 0;
    for (;;) {
      const batch = await this.source.listVerified(afterHost, SWEEP_BATCH);
      for (const domain of batch) {
        const payload: RecheckDomainPayload = { domainId: domain.id, round };
        await this.jobs.enqueue(RECHECK_DOMAIN_JOB, payload, {
          tenantId: domain.tenantId,
          idempotencyKey: `domains.recheck:${domain.id}:${round}`,
        });
      }
      planned += batch.length;
      if (batch.length < SWEEP_BATCH) break;
      afterHost = batch[batch.length - 1].host;
    }
    this.logger.log({ event: 'domains.recheck_planned', planned });
    return planned;
  }
}

/**
 * Una comprobación (corre con el tenant del dominio en el contexto). Si el
 * TXT con el token sigue publicado, reinicia la cuenta de fallos; si no, suma
 * uno y al llegar a DOMAIN_RECHECK_MAX_FAILURES seguidos el dominio pasa a
 * DISABLED: deja de enrutar (TenantResolverService solo enruta VERIFIED) y la
 * clínica lo ve «Desactivado».
 *
 * Un DNS que no responde (SERVFAIL, timeout) se reintenta con el backoff de
 * la cola; si sigue sin responder en el último intento cuenta como fallo: un
 * tercero que compre el dominio no puede esquivar la desactivación haciendo
 * que su DNS falle. Idempotente por ronda (la cola es «al menos una vez»).
 */
@Injectable()
export class RecheckDomain {
  private readonly logger = new Logger('Domains');

  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(DOMAINS_CONFIG) private readonly config: DomainsConfig,
  ) {}

  async handle(
    payload: Record<string, unknown>,
    context: Pick<JobContext, 'attempt' | 'maxAttempts' | 'tenantId'>,
  ): Promise<void> {
    const { domainId, round: rawRound } = payload;
    const round = typeof rawRound === 'string' ? new Date(rawRound) : null;
    if (
      typeof domainId !== 'string' ||
      !UUID.test(domainId) ||
      !round ||
      Number.isNaN(round.getTime())
    ) {
      throw new Error('domains.recheck: payload inválido');
    }
    const domain = await this.repo.findForRecheck(domainId, round);
    // Borrado, desactivado o ya comprobado en esta ronda: nada que hacer.
    if (!domain) return;

    let found: boolean;
    try {
      const records = await this.dns.resolveTxt(
        verificationRecordName(domain.host),
      );
      found = hasVerificationToken(records, domain.verifyToken);
    } catch (error) {
      if (!(error instanceof DnsLookupError)) throw error;
      if (context.attempt < context.maxAttempts) throw error;
      found = false;
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
