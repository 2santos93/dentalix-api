import { Inject, Injectable, Logger } from '@nestjs/common';
import { resolveCatalogLanguage } from '../../../shared/i18n/patient-language';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { EnqueueOptions, EnqueueResult } from '../../jobs/domain/job';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import {
  DEFAULT_EMAIL_LOCALE,
  EMAIL_LOCALES,
} from '../../notifications/email/domain/email-message';
import { ConfigService } from '@nestjs/config';
import {
  generateConfirmationToken,
  hashConfirmationToken,
} from '../../appointment-confirmations/application/confirmation-token';
import {
  MAIL_CONFIG,
  type MailConfig,
} from '../../notifications/email/infrastructure/mail-config';
import { optOutPositiveInteger } from '../../reminders/application/opt-out-config';
import { OPT_OUT_PATH } from '../../reminders/application/reminder-opt-out-links';
import { FollowUpBudgetLinks } from '../../signature-requests/application/follow-up-budget-links';
import { SIGNATURE_LINK_TTL_HOURS } from '../../signature-requests/domain/signature-token';
import { uuidV7 } from '../../weekly-digest/domain/uuid-v7';
import {
  FollowUpQuotaExceededError,
  QUOTE_FOLLOW_UP_CLOCK,
  QUOTE_FOLLOW_UP_REPOSITORY,
  type FollowUpGroupSnapshot,
  type QuoteFollowUpClock,
  type QuoteFollowUpRepository,
} from '../domain/ports/quote-follow-up-repository.port';
import {
  decideFollowUp,
  inSendWindow,
  planNextStep,
  TOO_LATE_AFTER_DAYS,
  type FollowUpDecision,
  type FollowUpSkipReason,
} from '../domain/quote-follow-up-schedule';

const DAY_MS = 24 * 60 * 60 * 1000;

export const QUOTE_FOLLOW_UP_SEND_JOB = 'quote-follow-up.send';
export const QUOTE_FOLLOW_UP_SWEEP_JOB = 'quote-follow-up.sweep';
export const QUOTE_FOLLOW_UP_SWEEP_SCHEDULE = 'quote-follow-up.sweep.hourly';
/** Cada hora: cada sede recibe los suyos dentro de SU franja horaria. */
export const QUOTE_FOLLOW_UP_SWEEP_CRON = '23 * * * *';

/**
 * Clave idempotente del trabajo de un grupo y paso EN UNA PASADA (la hora
 * UTC del barrido). La cola guarda la clave mientras existe la fila del
 * trabajo (JOBS_RETENTION_DAYS): con solo `quote-follow-up:<grupo>:<paso>`
 * un paso que no pudo salir (el tope de emails, la franja que se cerró antes
 * de ejecutarse) no se volvería a encolar. Con la hora, la pasada siguiente lo
 * reintenta; lo que impide un segundo aviso es el candado del grupo y el
 * UNIQUE (grupo, paso) de quote_follow_up_messages.
 */
export function quoteFollowUpJobKey(
  groupId: string,
  step: number,
  now: Date,
): string {
  return `quote-follow-up:${groupId}:${step}:${now.toISOString().slice(0, 13)}`;
}

/** Lo que el barrido necesita de la cola (DX-085). */
export const QUOTE_FOLLOW_UP_JOB_QUEUE = Symbol('QUOTE_FOLLOW_UP_JOB_QUEUE');
export interface QuoteFollowUpJobQueue {
  enqueue(
    name: string,
    payload: { groupId: string; step: number },
    options: EnqueueOptions,
  ): Promise<EnqueueResult>;
}

/** El worker perdió la reserva del trabajo (o se apaga): sin efectos. */
export function assertLeaseHeld(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Intento abortado');
}

/**
 * I1: el seguimiento gasta como mucho la MITAD del tope diario de emails de
 * la clínica (`MAIL_TENANT_DAILY_LIMIT`), contando sus propios emails de las
 * últimas 24 h: nunca se come el cupo del personal.
 */
export const FOLLOW_UP_DAILY_SHARE = 0.5;
export function followUpDailyCap(config: MailConfig): number {
  return Math.floor(config.quotas.tenantDaily * FOLLOW_UP_DAILY_SHARE);
}

/** DEFERRED (I2): el plan tiene un enlace de la clínica vigente. */
export type QuoteFollowUpSendResult =
  | 'SENT'
  | 'SKIPPED'
  | 'NOOP'
  | 'STALE'
  | 'ALREADY_DONE'
  | 'CHANGED'
  | 'DEFERRED'
  | 'QUOTA';

function sameDecision(a: FollowUpDecision, b: FollowUpDecision): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * El aviso de UN grupo y paso (D2–D4), con la clínica del trabajo en el
 * contexto. No se fía del payload: relee el grupo, los ajustes y el paciente
 * bajo RLS, decide, y vuelve a decidir con el grupo bloqueado antes de
 * escribir. Enviado: las solicitudes de firma de cada opción, el email (con
 * tope: si no cabe, no queda NADA y la pasada siguiente lo reintenta) y el
 * registro del paso en UNA transacción. Omitido: el registro con su motivo.
 */
@Injectable()
export class QuoteFollowUpSender {
  private readonly logger = new Logger('QuoteFollowUp');

  constructor(
    @Inject(QUOTE_FOLLOW_UP_REPOSITORY)
    private readonly repo: QuoteFollowUpRepository,
    private readonly budgetLinks: FollowUpBudgetLinks,
    private readonly linkBases: TenantLinkBaseService,
    private readonly email: EmailOutbox,
    @Inject(QUOTE_FOLLOW_UP_CLOCK) private readonly clock: QuoteFollowUpClock,
    @Inject(MAIL_CONFIG) private readonly mailConfig: MailConfig,
    config: ConfigService,
  ) {
    // El mismo TTL que el enlace de baja del recordatorio (DX-128).
    this.optOutTtlDays = optOutPositiveInteger(
      config,
      'REMINDER_OPT_OUT_LINK_TTL_DAYS',
      60,
    );
  }

  private readonly optOutTtlDays: number;

  async send(
    tenantId: string,
    groupId: string,
    step: number,
    signal?: AbortSignal,
  ): Promise<QuoteFollowUpSendResult> {
    const now = this.clock();
    const result = await this.run(tenantId, groupId, step, now, signal);
    this.logger.log({
      event: 'quote_follow_up.step',
      tenantId,
      groupId,
      step,
      outcome: result.outcome,
      ...(result.detail ? { detail: result.detail } : {}),
    });
    return result.outcome;
  }

  private async run(
    tenantId: string,
    groupId: string,
    step: number,
    now: Date,
    signal?: AbortSignal,
  ): Promise<{ outcome: QuoteFollowUpSendResult; detail?: string }> {
    const snapshot = await this.repo.loadGroup(groupId, now);
    if (!snapshot || snapshot.patient.archived) {
      return { outcome: 'NOOP', detail: 'NOT_FOUND' };
    }
    const decide = (s: FollowUpGroupSnapshot) =>
      decideFollowUp({
        now,
        group: s.facts,
        settings: s.settings,
        contact: s.contact,
      });
    const decision = decide(snapshot);
    if (decision.kind === 'NOOP')
      return { outcome: 'NOOP', detail: decision.why };
    // Otro paso venció entre el barrido y el trabajo: ya lo encolará la
    // pasada siguiente con su clave.
    if (decision.step !== step) return { outcome: 'STALE' };
    const stillHolds = (s: FollowUpGroupSnapshot) =>
      sameDecision(decide(s), decision);

    const skip = async (
      reason: FollowUpSkipReason,
      planIds: string[],
    ): Promise<{ outcome: QuoteFollowUpSendResult; detail?: string }> => {
      assertLeaseHeld(signal);
      const written = await this.repo.recordSkip({
        groupId,
        step: decision.step,
        superseded: decision.superseded,
        reason,
        planIds,
        now,
        stillHolds,
      });
      return written === 'DONE'
        ? { outcome: 'SKIPPED', detail: reason }
        : { outcome: written };
    };
    if (decision.kind === 'SKIP')
      return skip(decision.reason, decision.planIds);

    // El profesional de cada opción: quien la elaboró (DENTIST o ADMIN
    // activo); si no, el de otra opción del grupo; sin ninguno, no sale.
    const fallback = Object.values(snapshot.professionals).find(
      (p): p is string => p !== null,
    );
    const options = decision.planIds.map((planId) => ({
      planId,
      professionalUserId: snapshot.professionals[planId] ?? fallback ?? null,
    }));
    if (options.some((o) => o.professionalUserId === null)) {
      return skip('NO_PROFESSIONAL', decision.planIds);
    }
    const linkBase = await this.linkBases.forTenant(tenantId);
    if (!linkBase) return skip('NO_LINK_HOST', decision.planIds);
    const prepared = await this.budgetLinks.prepare({
      patientId: snapshot.facts.patientId,
      locationId: snapshot.facts.locationId,
      options: options as { planId: string; professionalUserId: string }[],
      linkBase,
      now,
    });
    if (!prepared.ok) {
      return prepared.reason === 'NO_EMAIL'
        ? skip('NO_EMAIL', decision.planIds)
        : { outcome: 'CHANGED', detail: 'NOT_SENDABLE' };
    }
    // DX-497: el idioma del paciente si hay catálogo para él; si no, el de
    // la clínica, y el registro lo dice.
    const { language, fallbackFrom } = resolveCatalogLanguage(
      snapshot.patient.preferredLanguage,
      EMAIL_LOCALES,
      DEFAULT_EMAIL_LOCALE,
    );
    // La baja (DX-128): el token solo viaja en el email; su hash se guarda en
    // la transacción del aviso.
    const optOutToken = generateConfirmationToken();
    const id = uuidV7(now.getTime());
    const requests = prepared.options.map((o) => ({
      id: uuidV7(now.getTime()),
      input: o.request,
      planQuoteValidity: o.planQuoteValidity,
    }));
    const mail = await this.email.prepareInTx({
      tenantId,
      to: prepared.recipient.email,
      template: 'quote-follow-up',
      referenceId: id,
      locale: language,
      // Lo dispara la clínica: cuenta y se frena en sus topes (D3).
      enforceQuota: true,
      vars: {
        recipientFirstName: prepared.recipient.greetingName,
        patientFirstName: prepared.recipient.minor
          ? prepared.recipient.patientFirstName
          : null,
        clinicName: prepared.clinicName,
        urls: prepared.options.map((o) => o.url),
        expiresInHours: SIGNATURE_LINK_TTL_HOURS,
        unsubscribeUrl: `${linkBase}${OPT_OUT_PATH}/${optOutToken}`,
      },
    });
    // Última puerta antes del efecto: con la reserva perdida, otro worker ya
    // tiene el trabajo (y el UNIQUE del paso lo cubriría igual).
    assertLeaseHeld(signal);
    try {
      const written = await this.repo.send({
        id,
        groupId,
        step: decision.step,
        superseded: decision.superseded,
        now,
        requests,
        email: mail,
        recipientMasked: prepared.recipient.destinationMasked,
        language,
        languageFallbackFrom: fallbackFrom,
        stillHolds,
        dailyCap: followUpDailyCap(this.mailConfig),
        optOut: {
          tokenHash: hashConfirmationToken(optOutToken),
          expiresAt: new Date(
            now.getTime() + this.optOutTtlDays * 24 * 60 * 60 * 1000,
          ),
        },
        cancelSuperseded: async (tx, superseded) => {
          for (const requestId of superseded.signatureRequestIds) {
            await this.email.supersedePendingInTx(
              tx,
              requestId,
              'signature-request',
            );
          }
          for (const messageId of superseded.followUpMessageIds) {
            await this.email.supersedePendingInTx(
              tx,
              messageId,
              'quote-follow-up',
            );
          }
        },
      });
      if (written !== 'DONE') return { outcome: written };
    } catch (error) {
      if (
        error instanceof EmailQuotaExceededError ||
        error instanceof FollowUpQuotaExceededError
      ) {
        return { outcome: 'QUOTA' };
      }
      throw error;
    }
    mail.kick();
    return { outcome: 'SENT' };
  }
}

/**
 * Barrido horario (D4): por clínica y sede con el seguimiento activo y DENTRO
 * de su franja (hora de pared de la sede), encola un trabajo por cada grupo
 * con un paso que toca hoy. Atrapa el fallo de una clínica, sigue con las
 * demás y falla al final (para que se vea en la cola).
 */
@Injectable()
export class QuoteFollowUpSweep {
  private readonly logger = new Logger('QuoteFollowUp');

  constructor(
    @Inject(QUOTE_FOLLOW_UP_REPOSITORY)
    private readonly repo: QuoteFollowUpRepository,
    @Inject(QUOTE_FOLLOW_UP_JOB_QUEUE)
    private readonly queue: QuoteFollowUpJobQueue,
    @Inject(QUOTE_FOLLOW_UP_CLOCK) private readonly clock: QuoteFollowUpClock,
    private readonly tenantContext: TenantContextService,
    @Inject(MAIL_CONFIG) private readonly mailConfig: MailConfig,
  ) {}

  async run(): Promise<{ queued: number }> {
    const now = this.clock();
    let queued = 0;
    let failed = 0;
    for (const tenantId of await this.repo.tenantIds()) {
      try {
        queued += await this.tenantContext.run(tenantId, () =>
          this.planTenant(tenantId, now),
        );
      } catch (error) {
        failed += 1;
        this.logger.warn({
          event: 'quote_follow_up.sweep_failed',
          tenantId,
          error: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    this.logger.log({ event: 'quote_follow_up.swept', queued, failed });
    if (failed > 0) {
      throw new Error(
        `Barrido del seguimiento de presupuestos falló en ${failed} clínica(s)`,
      );
    }
    return { queued };
  }

  private async planTenant(tenantId: string, now: Date): Promise<number> {
    let queued = 0;
    // I1: lo que queda del cupo del seguimiento; lo que no cabe ni se encola
    // ni se registra (sale en pasadas posteriores).
    let room =
      followUpDailyCap(this.mailConfig) -
      (await this.repo.followUpEmailsLast24h(tenantId));
    if (room <= 0) {
      this.logger.warn({ event: 'quote_follow_up.daily_cap', tenantId });
      return 0;
    }
    for (const { locationId, settings } of await this.repo.sweepLocations(
      tenantId,
    )) {
      const { timeZone } = settings;
      if (
        !inSendWindow(
          now,
          timeZone,
          settings.sendFromHour,
          settings.sendUntilHour,
        )
      ) {
        continue;
      }
      const today = civilDateIn(now, timeZone);
      // Más atrás que el último aviso + el margen de TOO_LATE no queda nada
      // que enviar ni que omitir.
      const horizon =
        Math.max(...settings.offsetsDays) + TOO_LATE_AFTER_DAYS + 2;
      // Un día de más cubre cualquier desfase de la zona.
      const since = new Date(now.getTime() - (horizon + 1) * DAY_MS);
      const candidates = await this.repo.sweepCandidates(
        tenantId,
        locationId,
        since,
        now,
      );
      for (const c of candidates) {
        if (room <= 0) break;
        const plan = planNextStep({
          presentedDay: civilDateIn(c.presentedAt, timeZone),
          offsetsDays: settings.offsetsDays,
          recorded: c.recorded,
          today,
        });
        if (!plan) continue;
        const { created } = await this.queue.enqueue(
          QUOTE_FOLLOW_UP_SEND_JOB,
          { groupId: c.groupId, step: plan.step },
          {
            tenantId,
            outsideTransaction: true,
            idempotencyKey: quoteFollowUpJobKey(c.groupId, plan.step, now),
          },
        );
        if (created) queued += 1;
        room -= 1;
      }
    }
    return queued;
  }
}
