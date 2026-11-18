import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
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
import { CreateConfirmationLinkUseCase } from '../../../appointment-confirmations/application/use-cases/create-confirmation-link.use-case';
import { RespondConfirmationUseCase } from '../../../appointment-confirmations/application/use-cases/respond-confirmation.use-case';
import { isMinor } from '../../../patients/domain/responsible-parties/majority-age';
import {
  GetPlanQuoteUseCase,
  PLAN_QUOTE_COMPOSITION,
  composeQuoteContent,
  quoteValidityOf,
} from '../../../treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  computeAcceptanceHash,
  computeQuoteHash,
  type QuoteComposition,
} from '../../../treatment-plans/domain/plan-quote';
import {
  parseSignaturePng,
  SignatureImageError,
} from '../../../consents/domain/signature-image';
import { DocumentTypeNamesReader } from '../../../patients/domain/ports/document-type-names-repository.port';
import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import { describeDeliveryError } from '../../../notifications/email/application/retry-policy';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import {
  toPortalAccount,
  toPortalQuote,
  type PortalAccount,
  type PortalQuote,
} from '../portal-projection';
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
  PORTAL_PLANS_SCOPE_REQUIRED_CODE,
  PORTAL_PLANS_SCOPE_REQUIRED_MESSAGE,
  PORTAL_QUOTE_CHANGED_CODE,
  PORTAL_QUOTE_CHANGED_MESSAGE,
  PORTAL_QUOTE_NOT_ACCEPTABLE_CODE,
  PORTAL_QUOTE_NOT_ACCEPTABLE_MESSAGE,
  PORTAL_QUOTE_NOT_FOUND_MESSAGE,
  PORTAL_SIGNER_NAME_MAX,
  PortalQuoteChangedError,
  PortalQuoteNotAcceptableError,
  isPortalQuoteAcceptable,
} from '../../domain/portal-quote-acceptance';
import {
  PATIENT_ACCESS_REPOSITORY,
  type PatientAccessRepository,
  type PortalAppointment,
  type PortalPlanRef,
} from '../../domain/ports/patient-access-repository.port';
import {
  PORTAL_ACCEPTANCE_EMAIL,
  type PortalAcceptanceEmail,
} from '../portal-acceptance-email';
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
  /**
   * DX-101-bis: «Aceptar presupuesto» desde el portal (presentado, sin
   * firmar, con ítems, no vencido, sin otra opción del grupo elegida y con
   * el apartado de presupuestos compartido).
   */
  acceptable: boolean;
  /** Último día válido del presupuesto (`YYYY-MM-DD`), el de `quote`. */
  validUntil: string;
  /** El hash que se manda al aceptar (el de `quote`). */
  contentHash: string;
  /** Aceptado: cuándo (hora del servidor); si no, null. */
  acceptedAt: Date | null;
  quote: PortalQuote;
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
  account: PortalAccount | null;
}

/** Quien «consulta» el estado de cuenta desde el portal: nunca puede anular. */
const PORTAL_VOID_ACTOR = {
  userId: '00000000-0000-0000-0000-000000000000',
  role: 'ASSISTANT',
} as const;

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
            // Lista blanca: ni notas, ni motivo, ni ids de profesional o sede.
            rows.map((a) => ({
              id: a.id,
              start: a.start,
              end: a.end,
              status: a.status,
              typeName: a.typeName,
              providerName: a.providerName,
              location: {
                name: a.location.name,
                address: a.location.address,
                timeZone: a.location.timeZone,
                locale: a.location.locale,
                hourCycle: a.location.hourCycle,
              },
              confirmable: a.status === 'SCHEDULED',
            })),
          )
        : Promise.resolve(null),
      has('PLANS') ? this.plans(patientId, now) : Promise.resolve(null),
      has('ACCOUNT')
        ? this.getStatement
            .execute(patientId, {}, PORTAL_VOID_ACTOR)
            .then(toPortalAccount)
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

  private async plans(patientId: string, now: Date): Promise<PortalPlanView[]> {
    const refs = await this.repo.sharedPlans(patientId);
    const views: PortalPlanView[] = [];
    // En serie: pocas y cada una ya hace varias lecturas.
    for (const ref of refs)
      views.push(await this.planView(patientId, ref, now));
    return views;
  }

  /** DX-101-bis: un plan compartido del paciente, como en `GET me`. */
  async plan(
    principal: PatientAccessPrincipal,
    planId: string,
  ): Promise<PortalPlanView | null> {
    const [ref] = await this.repo.sharedPlans(principal.patientId, planId);
    return ref ? this.planView(principal.patientId, ref, this.clock()) : null;
  }

  private async planView(
    patientId: string,
    ref: PortalPlanRef,
    now: Date,
  ): Promise<PortalPlanView> {
    const quote = toPortalQuote(await this.getQuote.execute(patientId, ref.id));
    return {
      id: ref.id,
      status: ref.status,
      optionGroupId: ref.optionGroupId,
      optionLabel: ref.optionLabel,
      // Solo se ve con el apartado de presupuestos: siempre compartido aquí.
      acceptable: isPortalQuoteAcceptable(
        {
          status: ref.status,
          accepted: quote.acceptance !== null,
          siblingChosen: ref.siblingChosen,
          itemCount: quote.items.length,
          validUntil: ref.quoteValidUntil,
          // La sede de la presentación; sin zona válida, la del presupuesto
          // (la misma regla que al aceptar).
          timeZone: ref.quoteTimeZone ?? quote.regional?.timeZone ?? null,
        },
        now,
      ),
      validUntil: quote.validUntil,
      contentHash: quote.contentHash,
      acceptedAt: quote.acceptance?.acceptedAt ?? null,
      quote,
    };
  }
}

export interface AcceptPortalQuoteInput {
  signerName: string;
  /** `data:image/png;base64,…` o base64 pelado. */
  signature: string;
  /** El `contentHash` del presupuesto que mostró el portal. */
  contentHash: string;
}

function portalConflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code,
    message,
  });
}

/**
 * PÚBLICO (con sesión, DX-101-bis): el paciente (o el responsable de un
 * menor) acepta con su firma un presupuesto compartido en el portal. Es la
 * MISMA aceptación que la del enlace de firma (DX-415, núcleo compartido):
 * foto del presupuesto vivo con su hash, firma, hora de la BD y un segundo
 * hash que lo sella; el plan pasa a ACCEPTED y las demás opciones abiertas
 * del grupo a REJECTED (DX-040, DX-109). Evidencia: el enlace de acceso de la
 * sesión, la IP y el navegador. Después, el email de confirmación si el
 * paciente tiene email en su ficha.
 *
 * Reglas, en orden: apartado de presupuestos (403); el plan del paciente del
 * enlace (404); el enlace releído en la transacción (410, como el guard); se
 * puede aceptar (409 genérico, sin decir por qué); es el presupuesto mostrado
 * (409 «ha cambiado»). Dos aceptaciones a la vez: una sola gana; la otra, 409.
 */
@Injectable()
export class AcceptPortalQuoteUseCase {
  private readonly logger = new Logger(AcceptPortalQuoteUseCase.name);

  constructor(
    @Inject(PATIENT_ACCESS_REPOSITORY)
    private readonly repo: PatientAccessRepository,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    private readonly portal: GetPatientPortalUseCase,
    @Inject(PORTAL_ACCEPTANCE_EMAIL)
    private readonly email: PortalAcceptanceEmail,
    @Optional()
    @Inject(PLAN_QUOTE_COMPOSITION)
    private readonly composition: QuoteComposition = 'current',
  ) {}

  async execute(
    principal: PatientAccessPrincipal,
    planId: string,
    input: AcceptPortalQuoteInput,
    meta: AuditRequestMeta,
  ): Promise<PortalPlanView> {
    if (!principal.scopes.includes('PLANS')) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        error: 'Forbidden',
        code: PORTAL_PLANS_SCOPE_REQUIRED_CODE,
        message: PORTAL_PLANS_SCOPE_REQUIRED_MESSAGE,
      });
    }
    // Lo barato, antes de tocar la base (como la aceptación en la clínica).
    const signerName = input.signerName.trim();
    if (signerName === '') {
      throw new BadRequestException('Escribe tu nombre para firmar.');
    }
    if (signerName.length > PORTAL_SIGNER_NAME_MAX) {
      throw new BadRequestException(
        `El nombre admite hasta ${PORTAL_SIGNER_NAME_MAX} caracteres.`,
      );
    }
    let signature: string;
    try {
      signature = parseSignaturePng(input.signature, 'tu firma');
    } catch (error) {
      if (error instanceof SignatureImageError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    // Los nombres de los documentos de la clínica (DX-524), por sede: con
    // ellos compone el presupuesto el portal (`GetPlanQuoteUseCase`).
    const book = await this.documentTypeNames.book();

    let outcome;
    try {
      outcome = await this.repo.acceptPlan({
        linkId: principal.linkId,
        patientId: principal.patientId,
        planId,
        signerName,
        signature,
        meta,
        decide: (source, { dbNow, siblingChosen }) => {
          if (
            !isPortalQuoteAcceptable(
              {
                status: source.plan.status,
                accepted: source.acceptance !== null,
                siblingChosen,
                itemCount: source.items.length,
                validUntil: source.plan.quoteValidUntil,
                timeZone:
                  source.plan.quoteRegional.timeZone ??
                  source.location.timeZone,
              },
              dbNow,
            )
          ) {
            throw new PortalQuoteNotAcceptableError();
          }
          // El presupuesto vivo, compuesto como lo mostró el portal.
          const content = composeQuoteContent(
            source,
            quoteValidityOf(source, dbNow),
            book.forLocation(source.location.id),
            this.composition,
          );
          const contentHash = computeQuoteHash(content);
          if (contentHash !== input.contentHash) {
            throw new PortalQuoteChangedError();
          }
          return {
            content,
            contentHash,
            acceptanceHash: computeAcceptanceHash({
              contentHash,
              signerName,
              signature,
              acceptedAt: dbNow,
            }),
          };
        },
      });
    } catch (error) {
      if (error instanceof PortalQuoteChangedError) {
        throw portalConflict(
          PORTAL_QUOTE_CHANGED_CODE,
          PORTAL_QUOTE_CHANGED_MESSAGE,
        );
      }
      // Ya aceptado, rechazado, vencido, otra opción elegida, otra aceptación
      // simultánea o una hermana cobrada (DX-109): el mismo 409, sin detalles.
      if (
        error instanceof PortalQuoteNotAcceptableError ||
        error instanceof ConflictException
      ) {
        throw portalConflict(
          PORTAL_QUOTE_NOT_ACCEPTABLE_CODE,
          PORTAL_QUOTE_NOT_ACCEPTABLE_MESSAGE,
        );
      }
      throw error;
    }
    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        message: PORTAL_QUOTE_NOT_FOUND_MESSAGE,
      });
    }
    if (outcome.kind === 'GONE') throw linkGone();

    await this.confirm(
      planId,
      signerName,
      outcome.acceptedAt,
      outcome.confirmation,
    );
    const view = await this.portal.plan(principal, planId);
    // Recién aceptado: siempre está entre los compartidos.
    if (!view) throw new Error(`Plan ${planId} aceptado y no visible`);
    return view;
  }

  /**
   * Email de confirmación (la plantilla de DX-415, variante de portal). La
   * aceptación ya está registrada: si el outbox falla, queda en el log (sin
   * destinatario) y el paciente ya la ve en el portal.
   */
  private async confirm(
    planId: string,
    signerName: string,
    acceptedAt: Date,
    confirmation: {
      to: string | null;
      clinicName: string;
      location: {
        id: string;
        locale: string | null;
        hourCycle: string | null;
        timeZone: string;
      };
    },
  ): Promise<void> {
    if (!confirmation.to) return;
    try {
      const format = requireLocationFormat({
        id: confirmation.location.id,
        locale: confirmation.location.locale,
        hourCycle: confirmation.location.hourCycle,
      });
      await this.email.sendBudgetAccepted({
        to: confirmation.to,
        referenceId: planId,
        vars: {
          recipientFirstName: firstNameOnly(signerName) ?? signerName,
          clinicName: confirmation.clinicName,
          acceptedAtLabel: format.longDateTime(
            acceptedAt,
            confirmation.location.timeZone,
          ),
          viaPortal: true,
        },
      });
    } catch (err) {
      this.logger.warn({
        event: 'patient_access.portal_acceptance_confirmation_not_enqueued',
        treatmentPlanId: planId,
        error: describeDeliveryError(err),
      });
    }
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
