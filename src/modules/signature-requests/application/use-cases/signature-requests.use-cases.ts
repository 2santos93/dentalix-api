import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SignatureRequestChannel,
  SignatureRequestType,
  TreatmentPlanStatus,
} from '@prisma/client';
import { describeDeliveryError } from '../../../notifications/email/application/retry-policy';
import {
  CONSENT_TEMPLATE_REPOSITORY,
  type ConsentTemplateRepository,
} from '../../../consents/domain/ports/consent-template-repository.port';
import { ConsentDocumentRenderer } from '../../../consents/application/use-cases/patient-consents.use-cases';
import { usesVariable } from '../../../consents/domain/render-consent';
import {
  composeQuoteContent,
  PLAN_NOT_FOUND_MESSAGE,
  quoteIssuedOn,
} from '../../../treatment-plans/application/use-cases/plan-quote.use-cases';
import { computeQuoteHash } from '../../../treatment-plans/domain/plan-quote';
import { PLAN_STATUS_LABELS } from '../../../treatment-plans/domain/plan-status-machine';
import {
  documentText,
  documentTypeName,
  type ClinicDocumentTypeNames,
} from '../../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../../patients/domain/ports/document-type-names-repository.port';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import { maskEmail } from '../../../../shared/privacy/mask-email';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  SignatureRequestListRow,
  SignatureRequestSummary,
} from '../../domain/entities/signature-request.entity';
import {
  SIGNATURE_REQUEST_REPOSITORY,
  type SignaturePlanOption,
  type SignatureProfessional,
  type SignatureRecipientContext,
  type SignatureRequestRepository,
} from '../../domain/ports/signature-request-repository.port';
import {
  resolveSignatureRecipient,
  type SignatureRecipient,
} from '../../domain/signature-recipient';
import { signatureRequestStatus } from '../../domain/signature-request-status';
import {
  buildSignatureUrl,
  generateSignatureToken,
  hashSignatureToken,
  signatureLinkExpiry,
} from '../../domain/signature-token';
import { SIGNATURE_CLOCK, type SignatureClock } from '../signature-clock';
import {
  SIGNATURE_EMAIL_SENDER,
  type SignatureEmailSender,
} from '../signature-email';
import type { SignatureRequestEmailVars } from '../../../notifications/email/domain/email-message';

export const SIGNATURE_BUDGET_PLAN_REQUIRED_MESSAGE =
  'Elige el presupuesto que quieres enviar a aceptar.';
export const SIGNATURE_BUDGET_ROLE_MESSAGE =
  'Solo el odontólogo o la administración envían un presupuesto a aceptar.';
export const SIGNATURE_BUDGET_EMPTY_MESSAGE =
  'El presupuesto no tiene ítems: agrega al menos un procedimiento antes de enviarlo.';
/** 409: solo un presupuesto «Presentado» (y sin aceptar) se envía a aceptar. */
export function budgetNotPresentedMessage(status: TreatmentPlanStatus): string {
  return `Solo se envía a aceptar un presupuesto «Presentado»: este está «${PLAN_STATUS_LABELS[status]}».`;
}
/** Título de la solicitud BUDGET (la ficha y la página pública). */
export const BUDGET_REQUEST_TITLE = 'Presupuesto de tratamiento';
/**
 * Condiciones que acepta el paciente al firmar (se congelan en la solicitud,
 * como el texto de un consentimiento). Los importes, la validez y la moneda
 * van en la foto del presupuesto.
 */
export const BUDGET_ACCEPTANCE_TERMS =
  'Al firmar aceptas este presupuesto y el plan de tratamiento que describe, con los importes, descuentos y la moneda indicados. El presupuesto es válido hasta la fecha que figura en él; si la clínica cambia algún ítem o precio, este enlace deja de servir y recibirás uno nuevo. Si el presupuesto tenía otras opciones, aceptar esta las rechaza.';
export const SIGNATURE_TEMPLATE_REQUIRED_MESSAGE =
  'Elige la plantilla del consentimiento que quieres enviar.';
export const SIGNATURE_INVALID_HOST_MESSAGE = 'Host no válido';
export const SIGNATURE_PROFESSIONAL_INVALID_MESSAGE =
  'Ese profesional no puede firmar consentimientos en esta clínica: elige un odontólogo, asistente o administrador activo.';
export const SIGNATURE_PROFESSIONAL_REQUIRED_MESSAGE =
  'Elige el profesional que firmará el consentimiento después en la app.';
export const SIGNATURE_REQUEST_NOT_FOUND_MESSAGE =
  'Solicitud de firma no encontrada';
export const SIGNATURE_NOT_PENDING_MESSAGE =
  'Esta solicitud ya está firmada o anulada: no hay nada que anular.';

/** Historial de la ficha: las últimas solicitudes del paciente. */
export const PATIENT_SIGNATURE_REQUESTS_LIMIT = 50;

export interface SignatureActor {
  userId: string;
  /** Rol clínico: puede ser el profesional que firma (si no elige otro). */
  clinical: boolean;
  /**
   * DX-415: decide el plan (TREATMENT_PLAN_DECISION_ROLES: odontólogo y
   * ADMIN). Solo él envía un presupuesto a aceptar: al firmarlo el paciente,
   * el plan pasa a ACCEPTED a nombre de quien lo envió, y la asistente y
   * recepción no aceptan planes (DX-040).
   */
  decidesPlans: boolean;
}

/** Fila de la ficha con su estado efectivo (caducar depende de la hora). */
export function toSignatureRequestSummary(
  row: SignatureRequestListRow,
  now: Date,
): SignatureRequestSummary {
  const { request, consent } = row;
  return {
    id: request.id,
    patientId: request.patientId,
    locationId: request.locationId,
    type: request.type,
    channel: request.channel,
    templateId: request.templateId,
    templateVersion: request.templateVersion,
    treatmentPlanId: request.treatmentPlanId,
    title: request.title,
    destinationMasked: request.destinationMasked,
    signerType: request.signerType,
    signerName: request.signerName,
    professionalUserId: request.professionalUserId,
    professionalName: request.professionalName,
    // Un presupuesto queda completo con la firma del paciente: no lleva
    // firma del profesional (la aceptación en la clínica tampoco).
    status: signatureRequestStatus(
      {
        ...request,
        countersigned:
          request.type === SignatureRequestType.BUDGET ||
          consent?.countersignedAt != null,
      },
      now,
    ),
    sentAt: request.createdAt,
    sentByName: row.sentByName,
    expiresAt: request.expiresAt,
    openedAt: request.openedAt,
    verifiedAt: request.verifiedAt,
    lockedAt: request.lockedAt,
    failedAttempts: request.failedAttempts,
    signedAt: request.signedAt,
    revokedAt: request.revokedAt,
    consentId: consent?.id ?? null,
    signedIpAddress:
      consent?.ipAddress ?? row.budgetAcceptance?.ipAddress ?? null,
    budgetAcceptanceId: row.budgetAcceptance?.id ?? null,
    countersignedAt: consent?.countersignedAt ?? null,
  };
}

function responsibleDocument(
  doc: SignatureRecipientContext['responsibles'][number]['document'],
  names: ClinicDocumentTypeNames,
): string | null {
  if (!doc.docNumber) return null;
  return doc.docType
    ? documentText(
        documentTypeName(doc.docType, doc.docTypeLabel, names),
        doc.docNumber,
      )
    : doc.docNumber;
}

function decideRecipient(
  ctx: SignatureRecipientContext,
  names: ClinicDocumentTypeNames,
  patientDocument: string | null,
  now: Date,
): SignatureRecipient {
  return resolveSignatureRecipient({
    patient: { ...ctx.patient, document: patientDocument },
    responsibles: ctx.responsibles.map((r) => ({
      ...r,
      documentText: responsibleDocument(r.document, names),
    })),
    majorityAge: ctx.majorityAge,
    today: civilDateIn(now, ctx.timeZone),
  });
}

export interface SignatureRequestOptions {
  templates: {
    id: string;
    title: string;
    version: number;
    /** El texto pinta {{tratamiento}}: sin plan dirá «No especificado». */
    usesTreatment: boolean;
    /** La última vez que el paciente lo firmó y quedó completo (o null). */
    lastCompletedAt: Date | null;
  }[];
  /** Quienes firman un consentimiento como profesional (CLINICAL_ROLES). */
  professionals: SignatureProfessional[];
  /** El propio usuario si es uno de ellos; si no, null (debe elegir). */
  defaultProfessionalId: string | null;
  /** Planes del paciente para {{tratamiento}}, también para recepción. */
  plans: SignaturePlanOption[];
  recipient: {
    allowed: boolean;
    /** Por qué no se puede enviar (sin email, menor sin responsable, baja). */
    reason: string | null;
    destinationMasked: string | null;
    signerType: 'PATIENT' | 'GUARDIAN' | null;
    signerName: string | null;
    minor: boolean;
  };
}

/**
 * `GET /patients/:patientId/signature-requests/options`: lo que necesita el
 * modal «Enviar a firmar», también para recepción (que no lee las plantillas
 * ni la ficha clínica): plantillas activas (título, versión, si usan
 * {{tratamiento}} y si el paciente ya las completó), profesionales que pueden
 * firmar, planes del paciente (estado y fecha, como los ve recepción en
 * «Presupuestos») y a quién iría (enmascarado) o por qué no se puede.
 */
@Injectable()
export class GetSignatureRequestOptionsUseCase {
  constructor(
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    @Inject(CONSENT_TEMPLATE_REPOSITORY)
    private readonly templates: ConsentTemplateRepository,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  async execute(
    patientId: string,
    actor: SignatureActor,
  ): Promise<SignatureRequestOptions> {
    const ctx = await this.repo.loadRecipientContext(patientId);
    if (!ctx) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const [templates, professionals, plans, completed, names] =
      await Promise.all([
        this.templates.list({ active: true }),
        this.repo.listProfessionals(),
        this.repo.listPlans(patientId),
        this.repo.listCompletedConsents(patientId),
        this.documentTypeNames.get(),
      ]);
    const lastCompleted = new Map<string, Date>();
    for (const c of completed) {
      const seen = lastCompleted.get(c.templateId);
      if (!seen || c.signedAt > seen)
        lastCompleted.set(c.templateId, c.signedAt);
    }
    const recipient = decideRecipient(ctx, names, null, this.clock());
    return {
      templates: templates.map((t) => ({
        id: t.id,
        title: t.title,
        version: t.version,
        usesTreatment: usesVariable(t.body, 'tratamiento'),
        lastCompletedAt: lastCompleted.get(t.id) ?? null,
      })),
      professionals,
      // Solo si quien envía puede firmar como profesional (la misma lista).
      defaultProfessionalId: professionals.some((p) => p.id === actor.userId)
        ? actor.userId
        : null,
      plans,
      recipient: recipient.ok
        ? {
            allowed: true,
            reason: null,
            destinationMasked: maskEmail(recipient.email),
            signerType: recipient.signerType,
            signerName: recipient.signerName,
            minor: recipient.minor,
          }
        : {
            allowed: false,
            reason: recipient.reason,
            destinationMasked: null,
            signerType: null,
            signerName: null,
            minor: false,
          },
    };
  }
}

export interface CreateSignatureRequestInput {
  type: SignatureRequestType;
  channel: SignatureRequestChannel;
  templateId?: string;
  treatmentPlanId?: string;
  professionalId?: string;
}

export interface CreatedSignatureRequest extends SignatureRequestSummary {
  /** false si el email no se pudo encolar (la solicitud queda registrada). */
  emailQueued: boolean;
}

/**
 * `POST /patients/:patientId/signature-requests` (DX-243): congela el texto
 * del consentimiento (plantilla + paciente + plan + profesional, como la
 * vista previa en pantalla) y lo envía por email al paciente o, si es menor,
 * a su responsable. El token solo viaja en el email; se guarda su hash.
 * Anula la solicitud anterior del mismo paciente y plantilla que aún
 * esperaba. Nada que falle deja una solicitud a medias: todo se comprueba
 * antes de escribir.
 *
 * BUDGET (DX-415): congela la FOTO del presupuesto de un plan «Presentado»
 * (la misma que firma la aceptación en la clínica, DX-012) y su hash; anula
 * el enlace anterior del mismo plan que aún esperaba.
 */
@Injectable()
export class CreateSignatureRequestUseCase {
  private readonly logger = new Logger('SignatureRequests');

  constructor(
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    private readonly renderer: ConsentDocumentRenderer,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    @Inject(SIGNATURE_EMAIL_SENDER)
    private readonly email: SignatureEmailSender,
    private readonly tenantContext: TenantContextService,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  async execute(
    patientId: string,
    input: CreateSignatureRequestInput,
    actor: SignatureActor,
    link: { protocol: string; host: string | null },
  ): Promise<CreatedSignatureRequest> {
    if (input.type === SignatureRequestType.BUDGET) {
      return this.createBudget(patientId, input, actor, link);
    }
    if (!input.templateId) {
      throw new BadRequestException(SIGNATURE_TEMPLATE_REQUIRED_MESSAGE);
    }
    if (!link.host) {
      throw new BadRequestException(SIGNATURE_INVALID_HOST_MESSAGE);
    }
    const professionalId =
      input.professionalId ?? (actor.clinical ? actor.userId : null);
    if (!professionalId) {
      throw new BadRequestException(SIGNATURE_PROFESSIONAL_REQUIRED_MESSAGE);
    }
    const professional = await this.repo.findProfessional(professionalId);
    if (!professional) {
      throw new BadRequestException(SIGNATURE_PROFESSIONAL_INVALID_MESSAGE);
    }

    const now = this.clock();
    // El mismo texto que vería en pantalla (404 paciente/plan/plantilla, 400
    // plantilla desactivada, 409 sede sin formato si pinta {{fecha}}).
    const prepared = await this.renderer.render(
      patientId,
      { templateId: input.templateId, treatmentPlanId: input.treatmentPlanId },
      professional.id,
      now,
    );
    // SEC-045: la solicitud se guarda en la sede del texto (la activa o, sin
    // ella, la principal); un miembro restringido no escribe en otra sede
    // (después no podría ni anularla).
    this.tenantContext.assertLocationAllowed(prepared.context.location.id);
    const ctx = await this.repo.loadRecipientContext(patientId);
    if (!ctx) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const recipient = decideRecipient(
      ctx,
      await this.documentTypeNames.get(),
      prepared.document,
      now,
    );
    if (!recipient.ok) {
      throw new UnprocessableEntityException(recipient.reason);
    }
    // El formato de la sede pinta la caducidad del email (409 si le falta).
    const format = requireLocationFormat(prepared.context.location);
    await this.email.assertCanSend(recipient.email);

    const token = generateSignatureToken();
    const expiresAt = signatureLinkExpiry(now);
    const destinationMasked = maskEmail(recipient.email);
    const created = await this.repo.create({
      locationId: prepared.context.location.id,
      patientId,
      type: input.type,
      channel: input.channel,
      templateId: prepared.template.id,
      templateVersion: prepared.template.version,
      treatmentPlanId: input.treatmentPlanId ?? null,
      title: prepared.title,
      body: prepared.body,
      professionalUserId: professional.id,
      professionalName: prepared.context.professionalName,
      signerType: recipient.signerType,
      signerName: recipient.signerName,
      signerDocument: recipient.signerDocument,
      destination: recipient.email,
      destinationMasked,
      tokenHash: hashSignatureToken(token),
      expiresAt,
      createdById: actor.userId,
      createdAt: now,
    });
    return this.finishCreate(created, now, {
      to: recipient.email,
      vars: {
        recipientFirstName: recipient.greetingName,
        patientFirstName: recipient.patientFirstName,
        clinicName: prepared.context.clinicName,
        url: buildSignatureUrl(link.protocol, link.host, token),
        expiresAtLabel: format.longDateTime(
          expiresAt,
          prepared.context.timeZone,
        ),
      },
    });
  }

  /**
   * DX-415: envía a aceptar el presupuesto de un plan «Presentado». La sede es
   * la del presupuesto (la activa o, sin ella, la principal); el profesional
   * que nombra el presupuesto es el que creó el plan, y la solicitud queda a
   * nombre de quien la envía (no hay firma del profesional después).
   */
  private async createBudget(
    patientId: string,
    input: CreateSignatureRequestInput,
    actor: SignatureActor,
    link: { protocol: string; host: string | null },
  ): Promise<CreatedSignatureRequest> {
    if (!actor.decidesPlans) {
      throw new ForbiddenException(SIGNATURE_BUDGET_ROLE_MESSAGE);
    }
    if (!input.treatmentPlanId) {
      throw new BadRequestException(SIGNATURE_BUDGET_PLAN_REQUIRED_MESSAGE);
    }
    if (!link.host) {
      throw new BadRequestException(SIGNATURE_INVALID_HOST_MESSAGE);
    }
    const ctx = await this.repo.loadRecipientContext(patientId);
    if (!ctx) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const budget = await this.repo.loadBudget(patientId, input.treatmentPlanId);
    if (!budget) throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    const { quote } = budget;
    // SEC-045: como el consentimiento, no se escribe en una sede ajena.
    this.tenantContext.assertLocationAllowed(quote.location.id);
    if (
      quote.plan.status !== TreatmentPlanStatus.PRESENTED ||
      quote.acceptance
    ) {
      throw new ConflictException(
        budgetNotPresentedMessage(
          quote.acceptance ? TreatmentPlanStatus.ACCEPTED : quote.plan.status,
        ),
      );
    }
    if (quote.items.length === 0) {
      throw new BadRequestException(SIGNATURE_BUDGET_EMPTY_MESSAGE);
    }

    const now = this.clock();
    const names = await this.documentTypeNames.get();
    const content = composeQuoteContent(
      quote,
      quoteIssuedOn(quote, now),
      names,
    );
    const recipient = decideRecipient(
      ctx,
      names,
      content.patient.document,
      now,
    );
    if (!recipient.ok) {
      throw new UnprocessableEntityException(recipient.reason);
    }
    const format = requireLocationFormat(budget.location);
    await this.email.assertCanSend(recipient.email);

    const token = generateSignatureToken();
    const expiresAt = signatureLinkExpiry(now);
    const created = await this.repo.create({
      locationId: quote.location.id,
      patientId,
      type: SignatureRequestType.BUDGET,
      channel: input.channel,
      templateId: null,
      templateVersion: null,
      treatmentPlanId: quote.plan.id,
      title: BUDGET_REQUEST_TITLE,
      body: BUDGET_ACCEPTANCE_TERMS,
      budgetContent: content,
      budgetContentHash: computeQuoteHash(content),
      professionalUserId: actor.userId,
      professionalName: (content.professionalName ?? content.clinicName).slice(
        0,
        200,
      ),
      signerType: recipient.signerType,
      signerName: recipient.signerName,
      signerDocument: recipient.signerDocument,
      destination: recipient.email,
      destinationMasked: maskEmail(recipient.email),
      tokenHash: hashSignatureToken(token),
      expiresAt,
      createdById: actor.userId,
      createdAt: now,
    });
    return this.finishCreate(created, now, {
      to: recipient.email,
      vars: {
        recipientFirstName: recipient.greetingName,
        patientFirstName: recipient.patientFirstName,
        clinicName: content.clinicName,
        url: buildSignatureUrl(link.protocol, link.host, token),
        expiresAtLabel: format.longDateTime(expiresAt, quote.location.timeZone),
      },
    });
  }

  /**
   * Tras guardar: cancela los emails de las solicitudes anuladas y encola el
   * del enlace. Un fallo del outbox no convierte la solicitud ya guardada en
   * un 500 (un reintento duplicaría el envío); la ficha lo dice y se puede
   * anular y enviar otra. Nunca se registra la URL ni el destinatario.
   */
  private async finishCreate(
    created: { id: string; supersededIds: string[] },
    now: Date,
    link: { to: string; vars: SignatureRequestEmailVars },
  ): Promise<CreatedSignatureRequest> {
    for (const id of created.supersededIds) {
      await this.cancelPendingEmail(id);
    }
    let emailQueued = false;
    try {
      await this.email.sendLink({ ...link, referenceId: created.id });
      emailQueued = true;
    } catch (err) {
      this.logger.warn({
        event: 'signature_request.email_not_enqueued',
        signatureRequestId: created.id,
        error: describeDeliveryError(err),
      });
    }
    const row = await this.repo.findById(created.id);
    if (!row) throw new NotFoundException(SIGNATURE_REQUEST_NOT_FOUND_MESSAGE);
    return { ...toSignatureRequestSummary(row, now), emailQueued };
  }

  private async cancelPendingEmail(id: string): Promise<void> {
    try {
      await this.email.cancelPendingLink(id);
    } catch (err) {
      this.logger.warn({
        event: 'signature_request.supersede_failed',
        signatureRequestId: id,
        error: describeDeliveryError(err),
      });
    }
  }
}

/** `GET /patients/:patientId/signature-requests`: lo que ve la ficha. */
@Injectable()
export class ListPatientSignatureRequestsUseCase {
  constructor(
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  /** 404 (no lista vacía) si el paciente no es de esta clínica. */
  async execute(patientId: string): Promise<SignatureRequestSummary[]> {
    const ctx = await this.repo.loadRecipientContext(patientId);
    if (!ctx) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const now = this.clock();
    const rows = await this.repo.listByPatient(
      patientId,
      PATIENT_SIGNATURE_REQUESTS_LIMIT,
    );
    return rows.map((row) => toSignatureRequestSummary(row, now));
  }
}

/**
 * `POST /patients/:patientId/signature-requests/:id/revoke`: anula un enlace
 * sin firmar (pendiente, abierto, bloqueado o caducado). Desde ese momento
 * responde «Enlace no válido». Cancela el email aún pendiente.
 */
@Injectable()
export class RevokeSignatureRequestUseCase {
  private readonly logger = new Logger('SignatureRequests');

  constructor(
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    @Inject(SIGNATURE_EMAIL_SENDER)
    private readonly email: SignatureEmailSender,
    private readonly tenantContext: TenantContextService,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  async execute(
    patientId: string,
    id: string,
    revokedById: string,
  ): Promise<SignatureRequestSummary> {
    const found = await this.repo.findById(id);
    if (!found || found.request.patientId !== patientId) {
      throw new NotFoundException(SIGNATURE_REQUEST_NOT_FOUND_MESSAGE);
    }
    // SEC-045: una solicitud enviada desde otra sede es 403.
    this.tenantContext.assertLocationAllowed(found.request.locationId);
    const now = this.clock();
    const outcome = await this.repo.revoke({ id, revokedById, now });
    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException(SIGNATURE_REQUEST_NOT_FOUND_MESSAGE);
    }
    if (outcome === 'NOT_PENDING') {
      throw new ConflictException(SIGNATURE_NOT_PENDING_MESSAGE);
    }
    try {
      await this.email.cancelPendingLink(id);
    } catch (err) {
      this.logger.warn({
        event: 'signature_request.supersede_failed',
        signatureRequestId: id,
        error: describeDeliveryError(err),
      });
    }
    const fresh = await this.repo.findById(id);
    if (!fresh)
      throw new NotFoundException(SIGNATURE_REQUEST_NOT_FOUND_MESSAGE);
    return toSignatureRequestSummary(fresh, now);
  }
}
