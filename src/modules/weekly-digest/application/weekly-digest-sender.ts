import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { parseCivilDate } from '../../../shared/time/civil-day';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { EnqueueOptions, EnqueueResult } from '../../jobs/domain/job';
import {
  WEEKLY_DIGEST_CLOCK,
  WEEKLY_DIGEST_REPOSITORY,
  type PreparedDelivery,
  type WeeklyDigestClock,
  type WeeklyDigestRepository,
} from '../domain/ports/weekly-digest-repository.port';
import { weeklyDigestEmailVars } from '../domain/weekly-digest-email';
import {
  dueDigest,
  mondayOf,
  sendableWeek,
  type DigestWeek,
} from '../domain/weekly-digest-schedule';
import { uuidV7 } from '../domain/uuid-v7';
import {
  isPrincipalConfigured,
  WeeklyDigestComposer,
} from './weekly-digest-composer';

export const WEEKLY_DIGEST_SEND_JOB = 'weekly-digest.send';
export const WEEKLY_DIGEST_SWEEP_JOB = 'weekly-digest.sweep';
export const WEEKLY_DIGEST_SWEEP_SCHEDULE = 'weekly-digest.sweep.hourly';
/** Cada hora: cada clínica recibe el suyo poco después de SU hora elegida. */
export const WEEKLY_DIGEST_SWEEP_CRON = '17 * * * *';
/** Caducidad del enlace de baja (D7). */
export const WEEKLY_DIGEST_UNSUBSCRIBE_TTL_DAYS = 60;

/** Clave idempotente del trabajo de una clínica y semana (D3). */
export function weeklyDigestJobKey(
  tenantId: string,
  weekStart: string,
): string {
  return `weekly-digest:${tenantId}:${weekStart}`;
}

/** Lo que el barrido necesita de la cola (DX-085). */
export const WEEKLY_DIGEST_JOB_QUEUE = Symbol('WEEKLY_DIGEST_JOB_QUEUE');
export interface WeeklyDigestJobQueue {
  enqueue(
    name: string,
    payload: { weekStart: string; dueAt: string },
    options: EnqueueOptions,
  ): Promise<EnqueueResult>;
}

/** El worker perdió la reserva del trabajo (o se apaga): sin efectos. */
export function assertLeaseHeld(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Intento abortado');
}

export type WeeklyDigestSendResult =
  'SENT' | 'SKIPPED' | 'ALREADY_DONE' | 'DISABLED' | 'NO_LOCATION' | 'STALE';

/**
 * El envío semanal de UNA clínica (la del trabajo, en el contexto). La cola
 * entrega «al menos una vez» y el barrido puede encolarlo otra vez tras la
 * purga de trabajos: lo que impide un segundo envío es el envío UNIQUE por
 * clínica y semana (D4), dentro de la misma transacción que las entregas y
 * sus emails. No se fía del payload: relee ajustes y destinatarios bajo RLS.
 */
@Injectable()
export class WeeklyDigestSender {
  private readonly logger = new Logger('WeeklyDigest');

  constructor(
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
    private readonly composer: WeeklyDigestComposer,
    private readonly email: EmailOutbox,
    @Inject(WEEKLY_DIGEST_CLOCK) private readonly clock: WeeklyDigestClock,
  ) {}

  async send(
    tenantId: string,
    weekStart: string,
    signal?: AbortSignal,
    dueAt: string | null = null,
  ): Promise<WeeklyDigestSendResult> {
    const due = dueAt === null ? null : new Date(dueAt);
    if (
      parseCivilDate(weekStart) === null ||
      mondayOf(weekStart) !== weekStart ||
      (due !== null && Number.isNaN(due.getTime()))
    ) {
      throw new Error(`${WEEKLY_DIGEST_SEND_JOB}: payload inválido`);
    }
    const clinic = await this.repo.clinic();
    // Sin sede principal con zona y formato no hay email (el barrido ya la
    // salta; esto cubre un cambio entre el barrido y el trabajo).
    if (!clinic || !isPrincipalConfigured(clinic)) return 'NO_LOCATION';
    if (!clinic.enabled) return 'DISABLED';
    // La semana del momento en que venció (hasta un día tarde: reintentos o
    // cola atrasada); nunca una que ya no toca.
    const now = this.clock();
    const week: DigestWeek | null = sendableWeek(
      weekStart,
      now,
      clinic.principal.timeZone,
      due,
    );
    if (!week) return 'STALE';
    if (await this.repo.runDone(week.weekStart)) return 'ALREADY_DONE';

    const composed = await this.composer.compose(clinic, week);
    const { eligible, configured } = await this.repo.eligibleRecipients();
    const expiresAt = new Date(
      now.getTime() + WEEKLY_DIGEST_UNSUBSCRIBE_TTL_DAYS * 86_400_000,
    );
    const deliveries: PreparedDelivery[] = [];
    for (const admin of eligible) {
      const id = uuidV7(now.getTime());
      const token = generatePublicLinkToken();
      deliveries.push({
        id,
        membershipId: admin.membershipId,
        tokenHash: hashPublicLinkToken(token),
        expiresAt,
        email: await this.email.prepareInTx({
          tenantId,
          to: admin.email,
          template: 'weekly-digest',
          referenceId: id,
          // Operativo y de bajo volumen: cuenta en el tope, no lo frena.
          enforceQuota: false,
          vars: weeklyDigestEmailVars({
            digest: composed.digest,
            clinicName: composed.clinicName,
            fmt: composed.fmt,
            linkBase: composed.linkBase,
            unsubscribeToken: token,
            isTest: false,
          }),
        }),
      });
    }
    // Última puerta antes del efecto: con la reserva perdida, otro worker
    // ya tiene el trabajo (y el UNIQUE del envío lo cubriría igual).
    assertLeaseHeld(signal);
    const outcome = await this.repo.sendRun({
      weekStart: week.weekStart,
      snapshot: composed.digest.receivablesSnapshot,
      deliveries,
      configuredRecipients: configured,
    });
    if (outcome.kind === 'SENT') {
      const sent = new Set(outcome.deliveryIds);
      for (const d of deliveries) if (sent.has(d.id)) d.email.kick();
    }
    this.logger.log({
      event: 'weekly_digest.run',
      tenantId,
      weekStart: week.weekStart,
      outcome: outcome.kind,
      ...(outcome.kind !== 'ALREADY_DONE'
        ? {
            sent: outcome.kind === 'SENT' ? outcome.sent : 0,
            skipped: outcome.skipped,
          }
        : {}),
    });
    return outcome.kind;
  }
}

/**
 * Barrido horario (D3): por cada clínica con el resumen activado, si en la
 * zona de su sede principal ya pasó el momento elegido de esta semana y aún
 * no hay envío de la semana anterior, encola su trabajo con clave idempotente
 * por clínica y semana. Atrapa el fallo de una clínica, sigue con las demás y
 * falla al final (para que se vea en la cola).
 */
@Injectable()
export class WeeklyDigestSweep {
  private readonly logger = new Logger('WeeklyDigest');

  constructor(
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
    @Inject(WEEKLY_DIGEST_JOB_QUEUE)
    private readonly queue: WeeklyDigestJobQueue,
    @Inject(WEEKLY_DIGEST_CLOCK) private readonly clock: WeeklyDigestClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async run(): Promise<{ queued: number }> {
    const now = this.clock();
    let queued = 0;
    let failed = 0;
    for (const tenantId of await this.repo.enabledTenantIds()) {
      try {
        const clinic = await this.tenantContext.run(tenantId, () =>
          this.repo.clinic(),
        );
        if (clinic && !clinic.enabled) continue;
        if (!clinic || !isPrincipalConfigured(clinic)) {
          // Sin zona o sin formato no hay email: el trabajo fallaría cada
          // semana. Se avisa y se salta hasta que el ADMIN la configure
          // (Ajustes lo dice con PRINCIPAL_LOCATION_UNCONFIGURED).
          this.logger.warn({
            event: 'weekly_digest.clinic_unconfigured',
            tenantId,
          });
          continue;
        }
        const due = dueDigest(
          now,
          { weekday: clinic.weekday, hour: clinic.hour },
          clinic.principal.timeZone,
        );
        if (!due || (await this.repo.runExists(tenantId, due.week.weekStart))) {
          continue;
        }
        const { week } = due;
        const { created } = await this.queue.enqueue(
          WEEKLY_DIGEST_SEND_JOB,
          { weekStart: week.weekStart, dueAt: due.dueAt.toISOString() },
          {
            tenantId,
            idempotencyKey: weeklyDigestJobKey(tenantId, week.weekStart),
          },
        );
        if (created) queued += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn({
          event: 'weekly_digest.sweep_failed',
          tenantId,
          error: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    if (failed > 0) {
      throw new Error(
        `Barrido del resumen semanal falló en ${failed} clínica(s)`,
      );
    }
    return { queued };
  }
}
