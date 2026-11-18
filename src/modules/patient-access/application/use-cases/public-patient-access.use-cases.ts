import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PatientAccessScope } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import {
  hashPublicLinkToken,
  isWellFormedPublicLinkToken,
} from '../../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { GetAccountStatementUseCase } from '../../../account-statement/application/use-cases/get-account-statement.use-case';
import type { AccountStatement } from '../../../account-statement/domain/entities/account-statement.entity';
import { CreateConfirmationLinkUseCase } from '../../../appointment-confirmations/application/use-cases/create-confirmation-link.use-case';
import { RespondConfirmationUseCase } from '../../../appointment-confirmations/application/use-cases/respond-confirmation.use-case';
import { isMinor } from '../../../patients/domain/responsible-parties/majority-age';
import {
  GetPlanQuoteUseCase,
  type PlanQuoteDocument,
} from '../../../treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  PATIENT_ACCESS_APPOINTMENT_NOT_FOUND_MESSAGE,
  PATIENT_ACCESS_FAILURE_FLOOR_MS,
  PATIENT_ACCESS_GONE_CODE,
  PATIENT_ACCESS_GONE_MESSAGE,
  PATIENT_ACCESS_INVALID_CODE,
  PATIENT_ACCESS_INVALID_MESSAGE,
  PATIENT_ACCESS_LOCKED_CODE,
  PATIENT_ACCESS_LOCKED_MESSAGE,
  PATIENT_ACCESS_SESSION_MINUTES,
  birthDateMatches,
  decideVerification,
  normalizeBirthDate,
  retryAfterSeconds,
  storedBirthDate,
  type VerifyDecision,
} from '../../domain/patient-access';
import { signPatientAccessSession } from '../../domain/patient-access-session';
import {
  PATIENT_ACCESS_REPOSITORY,
  type PatientAccessRepository,
  type PortalAppointment,
  type PortalPlanRef,
} from '../../domain/ports/patient-access-repository.port';
import {
  PATIENT_ACCESS_CLOCK,
  PATIENT_ACCESS_SESSION_KEY,
  PATIENT_ACCESS_SLEEPER,
  type PatientAccessClock,
  type PatientAccessSleeper,
} from '../patient-access-clock';
import { UnknownTokenAttempts } from '../unknown-token-attempts';

/** Lo que el guard deja en la petición: el enlace releído y nada más. */
export interface PatientAccessPrincipal {
  linkId: string;
  patientId: string;
  scopes: PatientAccessScope[];
  sessionExpiresAt: Date;
}

export function invalidData(): BadRequestException {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: PATIENT_ACCESS_INVALID_CODE,
    message: PATIENT_ACCESS_INVALID_MESSAGE,
  });
}

export function lockedOut(retryAfter: number): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code: PATIENT_ACCESS_LOCKED_CODE,
      message: PATIENT_ACCESS_LOCKED_MESSAGE,
      retryAfterSeconds: retryAfter,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function linkGone(): GoneException {
  return new GoneException({
    statusCode: HttpStatus.GONE,
    error: 'Gone',
    code: PATIENT_ACCESS_GONE_CODE,
    message: PATIENT_ACCESS_GONE_MESSAGE,
  });
}

export interface VerifiedPatientAccess {
  /** Valor de la cookie: va SOLO en `Set-Cookie`, nunca en el body. */
  cookieValue: string;
  sessionExpiresAt: Date;
  scopes: PatientAccessScope[];
}

/**
 * PÚBLICO: verifica la fecha de nacimiento y abre una sesión de 30 minutos.
 *
 * Sin enumeración: un token malformado, desconocido, de otra clínica,
 * caducado o revocado, un paciente archivado y una fecha errónea dan la MISMA
 * respuesta (400 «Datos incorrectos»), con el mismo suelo de tiempo. El
 * contador de un enlace vivo se lleva con la fila bloqueada; el de cualquier
 * otro token, con el espejo en memoria y la misma regla, así que el 429 del
 * quinto fallo tampoco dice si el token existe.
 */
@Injectable()
export class VerifyPatientAccessUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(PATIENT_ACCESS_REPOSITORY)
    private readonly repo: PatientAccessRepository,
    private readonly unknownTokens: UnknownTokenAttempts,
    @Inject(PATIENT_ACCESS_SESSION_KEY) private readonly sessionKey: Buffer,
    @Inject(PATIENT_ACCESS_CLOCK) private readonly clock: PatientAccessClock,
    @Inject(PATIENT_ACCESS_SLEEPER)
    private readonly sleep: PatientAccessSleeper,
  ) {}

  async execute(
    token: string,
    birthDate: unknown,
    meta: AuditRequestMeta,
  ): Promise<VerifiedPatientAccess> {
    const started = performance.now();
    const now = this.clock();
    const tenantId = this.tenantContext.getTenantId();
    const given = normalizeBirthDate(birthDate);
    const tokenHash = hashPublicLinkToken(String(token));

    let decision: VerifyDecision | null = null;
    let linkId: string | null = null;
    if (tenantId && isWellFormedPublicLinkToken(token)) {
      const outcome = await this.repo.verifyAttempt(
        tokenHash,
        (state) =>
          decideVerification(
            state,
            birthDateMatches(
              given,
              state.birthDate ? storedBirthDate(state.birthDate) : null,
            ),
            now,
          ),
        meta,
      );
      if (outcome.kind === 'DECIDED') {
        decision = outcome.decision;
        linkId = outcome.linkId;
      }
    } else {
      // Mismo trabajo de comparación que con un enlace real.
      birthDateMatches(given, null);
    }
    // Cualquier token que no es un enlace vivo de ESTA clínica.
    decision ??= this.unknownTokens.fail(
      `${tenantId ?? '-'}:${tokenHash}`,
      now,
    );

    if (decision.kind === 'OK' && linkId && tenantId) {
      const session = await this.repo.findSessionLink(linkId);
      if (session) {
        const sessionExpiresAt = new Date(
          Math.min(
            now.getTime() + PATIENT_ACCESS_SESSION_MINUTES * 60_000,
            session.expiresAt.getTime(),
          ),
        );
        return {
          cookieValue: signPatientAccessSession(
            this.sessionKey,
            tenantId,
            linkId,
            sessionExpiresAt,
          ),
          sessionExpiresAt,
          scopes: session.scopes,
        };
      }
    }

    // Suelo de tiempo: todo fallo tarda lo mismo, exista o no el enlace.
    const elapsed = performance.now() - started;
    if (elapsed < PATIENT_ACCESS_FAILURE_FLOOR_MS) {
      await this.sleep(PATIENT_ACCESS_FAILURE_FLOOR_MS - elapsed);
    }
    if (decision.kind === 'LOCKED' || decision.kind === 'LOCK') {
      throw lockedOut(retryAfterSeconds(decision.lockedUntil, now));
    }
    throw invalidData();
  }
}

export interface PortalAppointmentView extends PortalAppointment {
  /** Agendada (sin confirmar) y futura: muestra «Confirmar». */
  confirmable: boolean;
}

export interface PortalPlanView {
  id: string;
  status: PortalPlanRef['status'];
  optionGroupId: string | null;
  optionLabel: string | null;
  quote: PlanQuoteDocument;
}

export interface PatientPortalView {
  clinicName: string;
  patientFirstName: string;
  /** Menor de edad: el enlace lo usa su responsable (aviso en la página). */
  minor: boolean;
  scopes: PatientAccessScope[];
  sessionExpiresAt: Date;
  /** null = el apartado no se compartió. */
  appointments: PortalAppointmentView[] | null;
  plans: PortalPlanView[] | null;
  account: AccountStatement | null;
}

/** Quien «consulta» el estado de cuenta desde el portal: nunca puede anular. */
const PORTAL_VOID_ACTOR = {
  userId: '00000000-0000-0000-0000-000000000000',
  role: 'ASSISTANT',
} as const;

/**
 * El estado de cuenta del personal (DX-011) tal cual en importes (al céntimo,
 * DX-098), sin lo que solo sirve al personal: quién registró o anuló un abono,
 * el motivo interno de la anulación y si se puede anular.
 */
export function forPatient(statement: AccountStatement): AccountStatement {
  return {
    ...statement,
    movements: statement.movements.map((m) => ({
      ...m,
      createdById: null,
      canVoid: false,
      voidBlockedReason: null,
      periodLocked: false,
      voidedBy: null,
      voidReason: null,
    })),
  };
}

/** PÚBLICO (con sesión): solo los apartados compartidos, solo del paciente del enlace. */
@Injectable()
export class GetPatientPortalUseCase {
  constructor(
    @Inject(PATIENT_ACCESS_REPOSITORY)
    private readonly repo: PatientAccessRepository,
    private readonly getQuote: GetPlanQuoteUseCase,
    private readonly getStatement: GetAccountStatementUseCase,
    @Inject(PATIENT_ACCESS_CLOCK) private readonly clock: PatientAccessClock,
  ) {}

  async execute(principal: PatientAccessPrincipal): Promise<PatientPortalView> {
    const now = this.clock();
    const { patientId, scopes } = principal;
    const patient = await this.repo.portalPatient(patientId);
    if (!patient) throw linkGone();
    const clinic = await this.repo.clinicContext();
    const has = (scope: PatientAccessScope) => scopes.includes(scope);

    const [appointments, plans, account] = await Promise.all([
      has('APPOINTMENTS')
        ? this.repo.upcomingAppointments(patientId, now).then((rows) =>
            rows.map((a) => ({
              ...a,
              confirmable: a.status === 'SCHEDULED',
            })),
          )
        : Promise.resolve(null),
      has('PLANS') ? this.plans(patientId) : Promise.resolve(null),
      has('ACCOUNT')
        ? this.getStatement
            .execute(patientId, {}, PORTAL_VOID_ACTOR)
            .then(forPatient)
        : Promise.resolve(null),
    ]);

    return {
      clinicName: clinic.clinicName,
      patientFirstName: patient.firstName.trim().split(/\s+/)[0] ?? '',
      minor: isMinor(
        patient.birthDate,
        clinic.majorityAge,
        civilDateIn(now, clinic.timeZone),
      ),
      scopes,
      sessionExpiresAt: principal.sessionExpiresAt,
      appointments,
      plans,
      account,
    };
  }

  private async plans(patientId: string): Promise<PortalPlanView[]> {
    const refs = await this.repo.sharedPlans(patientId);
    const views: PortalPlanView[] = [];
    // En serie: pocas y cada una ya hace varias lecturas.
    for (const ref of refs) {
      views.push({
        ...ref,
        quote: await this.getQuote.execute(patientId, ref.id),
      });
    }
    return views;
  }
}

/**
 * PÚBLICO (con sesión): «Confirmar» una cita desde el portal por el flujo de
 * DX-005, sin exponer su token: se emite un enlace de confirmación automático
 * (no anula los que mandó recepción) y se responde `confirm` con él en el
 * servidor. La auditoría es la del enlace de confirmación
 * (CONFIRMATION_LINK_CONFIRMED). Solo citas futuras agendadas del paciente.
 */
@Injectable()
export class ConfirmPortalAppointmentUseCase {
  constructor(
    @Inject(PATIENT_ACCESS_REPOSITORY)
    private readonly repo: PatientAccessRepository,
    private readonly createConfirmation: CreateConfirmationLinkUseCase,
    private readonly respondConfirmation: RespondConfirmationUseCase,
    @Inject(PATIENT_ACCESS_CLOCK) private readonly clock: PatientAccessClock,
  ) {}

  async execute(
    principal: PatientAccessPrincipal,
    appointmentId: string,
    meta: AuditRequestMeta,
  ): Promise<{ status: 'CONFIRMED' }> {
    if (!principal.scopes.includes('APPOINTMENTS')) {
      throw new NotFoundException(PATIENT_ACCESS_APPOINTMENT_NOT_FOUND_MESSAGE);
    }
    const mine = await this.repo.findConfirmableAppointment(
      principal.patientId,
      appointmentId,
      this.clock(),
    );
    if (!mine) {
      throw new NotFoundException(PATIENT_ACCESS_APPOINTMENT_NOT_FOUND_MESSAGE);
    }
    const link = await this.createConfirmation.execute({
      appointmentId,
      automatic: true,
    });
    await this.respondConfirmation.execute(link.token, 'confirm', {}, meta);
    return { status: 'CONFIRMED' };
  }
}
