import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { maskEmail } from '../../../shared/privacy/mask-email';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { withEmailQuotaAs429 } from '../../notifications/email/application/email-quota-http';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import {
  WEEKLY_DIGEST_CLOCK,
  WEEKLY_DIGEST_REPOSITORY,
  type WeeklyDigestClock,
  type WeeklyDigestRepository,
  type WeeklyDigestSettings,
} from '../domain/ports/weekly-digest-repository.port';
import { weeklyDigestEmailVars } from '../domain/weekly-digest-email';
import {
  HOUR_MAX,
  HOUR_MIN,
  WEEKDAY_MAX,
  WEEKDAY_MIN,
  previousFullWeek,
} from '../domain/weekly-digest-schedule';
import { WeeklyDigestComposer } from './weekly-digest-composer';

export const WEEKLY_DIGEST_WEEKDAY_MESSAGE =
  'El día tiene que ser un número de 0 (domingo) a 6 (sábado).';
export const WEEKLY_DIGEST_HOUR_MESSAGE =
  'La hora tiene que ser un número entero de 0 a 23.';
export const WEEKLY_DIGEST_RECIPIENTS_MESSAGE =
  'Los destinatarios tienen que ser administradores activos de la clínica.';
export const WEEKLY_DIGEST_NOT_VERIFIED_MESSAGE =
  'Confirma tu correo antes de pedir una prueba: el resumen solo se envía a correos confirmados.';
export const WEEKLY_DIGEST_NO_LOCATION_MESSAGE =
  'La clínica no tiene una sede activa con zona horaria y formato: configúrala en Ajustes › Sedes.';
export const WEEKLY_DIGEST_TEST_ADMIN_ONLY_MESSAGE =
  'Solo un administrador activo de la clínica puede pedir una prueba del resumen.';

/** Una prueba por persona cada 5 minutos (D1). */
export const WEEKLY_DIGEST_TEST_COOLDOWN_SECONDS = 5 * 60;

/** Aviso del PUT: activado pero sin destinatarios (no sale nada). */
export type WeeklyDigestWarning = 'NO_RECIPIENTS';

export interface WeeklyDigestCandidate {
  membershipId: string;
  name: string;
  /** Enmascarado: basta para reconocerlo. */
  email: string;
  /** Solo se envía a correos confirmados. */
  verified: boolean;
}

export interface WeeklyDigestSettingsView extends WeeklyDigestSettings {
  candidates: WeeklyDigestCandidate[];
  warnings: WeeklyDigestWarning[];
}

export interface WeeklyDigestTestResult {
  /** A quién salió (enmascarado). */
  sentTo: string;
  weekStart: string;
  weekEnd: string;
}

function testWaitMessage(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return seconds < 60
    ? `Ya te enviamos una prueba hace un momento. Espera ${seconds} ${seconds === 1 ? 'segundo' : 'segundos'} para pedir otra.`
    : `Ya te enviamos una prueba hace un momento. Espera ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} para pedir otra.`;
}

/**
 * Ajustes › Resumen semanal (DX-568, D1): día, hora, activado y quién lo
 * recibe (los ADMIN activos), con los candidatos para la pantalla.
 */
@Injectable()
export class GetWeeklyDigestSettingsUseCase {
  constructor(
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
  ) {}

  async execute(): Promise<WeeklyDigestSettingsView> {
    return this.view(await this.repo.getSettings());
  }

  async view(
    settings: WeeklyDigestSettings,
  ): Promise<WeeklyDigestSettingsView> {
    const admins = await this.repo.activeAdmins();
    return {
      ...settings,
      candidates: admins.map((a) => ({
        membershipId: a.membershipId,
        name: a.fullName,
        email: maskEmail(a.email),
        verified: a.verified,
      })),
      warnings:
        settings.enabled && settings.recipientMembershipIds.length === 0
          ? ['NO_RECIPIENTS']
          : [],
    };
  }
}

/**
 * Cambia los ajustes (solo ADMIN, lo exige la ruta). Los destinatarios se
 * comprueban en la transacción (ADMIN activos de ESTA clínica: 400 si no) y
 * el cambio se audita ahí mismo, solo si algo cambió.
 */
@Injectable()
export class UpdateWeeklyDigestSettingsUseCase {
  constructor(
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
    private readonly getSettings: GetWeeklyDigestSettingsUseCase,
  ) {}

  async execute(
    input: WeeklyDigestSettings,
    ctx: AuditRequestContext,
  ): Promise<WeeklyDigestSettingsView> {
    if (
      !Number.isInteger(input.weekday) ||
      input.weekday < WEEKDAY_MIN ||
      input.weekday > WEEKDAY_MAX
    ) {
      throw new BadRequestException(WEEKLY_DIGEST_WEEKDAY_MESSAGE);
    }
    if (
      !Number.isInteger(input.hour) ||
      input.hour < HOUR_MIN ||
      input.hour > HOUR_MAX
    ) {
      throw new BadRequestException(WEEKLY_DIGEST_HOUR_MESSAGE);
    }
    const result = await this.repo.setSettings(input, ctx);
    if (!result.ok) {
      throw new BadRequestException(WEEKLY_DIGEST_RECIPIENTS_MESSAGE);
    }
    return this.getSettings.view(result.after);
  }
}

/**
 * «Enviarme una prueba» (D1): el resumen de la semana anterior completa,
 * AHORA y solo a quien lo pide (si su correo está confirmado), con
 * «[Prueba]» en el asunto y sin enlace de baja. No crea envío ni entrega
 * (no cuenta para la idempotencia del semanal). Una por persona cada 5
 * minutos (429), auditada (VIEW de CLINIC_SETTINGS) en la transacción que
 * encola el email.
 */
@Injectable()
export class SendWeeklyDigestTestUseCase {
  constructor(
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
    private readonly composer: WeeklyDigestComposer,
    private readonly email: EmailOutbox,
    @Inject(WEEKLY_DIGEST_CLOCK) private readonly clock: WeeklyDigestClock,
  ) {}

  execute(ctx: AuditRequestContext): Promise<WeeklyDigestTestResult> {
    return withEmailQuotaAs429(() => this.send(ctx));
  }

  private async send(
    ctx: AuditRequestContext,
  ): Promise<WeeklyDigestTestResult> {
    const me = (await this.repo.activeAdmins()).find(
      (a) => a.userId === ctx.actor.userId,
    );
    if (!me)
      throw new ForbiddenException(WEEKLY_DIGEST_TEST_ADMIN_ONLY_MESSAGE);
    if (!me.verified) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'EMAIL_NOT_VERIFIED',
        message: WEEKLY_DIGEST_NOT_VERIFIED_MESSAGE,
      });
    }
    const now = this.clock();
    // Aviso temprano (sin componer nada); el que manda va bajo candado.
    const wait = await this.repo.testCooldownRemaining(
      me.userId,
      WEEKLY_DIGEST_TEST_COOLDOWN_SECONDS,
      now,
    );
    if (wait > 0)
      throw new EmailQuotaExceededError(testWaitMessage(wait), wait);

    const clinic = await this.repo.clinic();
    if (!clinic) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'LOCATION_REQUIRED',
        message: WEEKLY_DIGEST_NO_LOCATION_MESSAGE,
      });
    }
    const week = previousFullWeek(civilDateIn(now, clinic.principal.timeZone));
    const composed = await this.composer.compose(clinic, week);
    const prepared = await this.email.prepareInTx({
      tenantId: ctx.tenantId,
      to: me.email,
      template: 'weekly-digest',
      // Lo pide una persona: aplica los topes de la clínica y del destinatario.
      enforceQuota: true,
      vars: weeklyDigestEmailVars({
        digest: composed.digest,
        clinicName: composed.clinicName,
        fmt: composed.fmt,
        linkBase: composed.linkBase,
        unsubscribeToken: null,
        isTest: true,
      }),
    });
    const recorded = await this.repo.recordTestSend(
      prepared,
      ctx,
      WEEKLY_DIGEST_TEST_COOLDOWN_SECONDS,
      now,
    );
    if (!recorded.ok) {
      throw new EmailQuotaExceededError(
        testWaitMessage(recorded.retryAfterSeconds),
        recorded.retryAfterSeconds,
      );
    }
    prepared.kick();
    return {
      sentTo: maskEmail(me.email),
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
    };
  }
}
