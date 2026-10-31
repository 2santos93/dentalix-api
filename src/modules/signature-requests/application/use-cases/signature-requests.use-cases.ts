import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SignatureRequestChannel, SignatureRequestType } from '@prisma/client';
import { describeDeliveryError } from '../../../notifications/email/application/retry-policy';
import {
  CONSENT_TEMPLATE_REPOSITORY,
  type ConsentTemplateRepository,
} from '../../../consents/domain/ports/consent-template-repository.port';
import { ConsentDocumentRenderer } from '../../../consents/application/use-cases/patient-consents.use-cases';
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

export const SIGNATURE_BUDGET_NOT_AVAILABLE_MESSAGE =
  'La firma a distancia de presupuestos aún no está disponible: envía un consentimiento.';
export const SIGNATURE_TEMPLATE_REQUIRED_MESSAGE =
  'Elige la plantilla del consentimiento que quieres enviar.';
export const SIGNATURE_INVALID_HOST_MESSAGE = 'Host no válido';
export const SIGNATURE_PROFESSIONAL_INVALID_MESSAGE =
  'Elige un profesional de la clínica con rol clínico: es quien firmará después en la app.';
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
    title: request.title,
    destinationMasked: request.destinationMasked,
    signerType: request.signerType,
    signerName: request.signerName,
    professionalUserId: request.professionalUserId,
    professionalName: request.professionalName,
    status: signatureRequestStatus(
      { ...request, countersigned: consent?.countersignedAt != null },
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
    signedIpAddress: consent?.ipAddress ?? null,
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
  templates: { id: string; title: string; version: number }[];
  professionals: { id: string; fullName: string }[];
  /** El propio usuario si tiene rol clínico; si no, null (debe elegir). */
  defaultProfessionalId: string | null;
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
 * ni la ficha clínica): plantillas activas (título y versión), profesionales
 * que pueden firmar y a quién iría (enmascarado) o por qué no se puede.
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
    const [templates, professionals, names] = await Promise.all([
      this.templates.list({ active: true }),
      this.repo.listProfessionals(),
      this.documentTypeNames.get(),
    ]);
    const recipient = decideRecipient(ctx, names, null, this.clock());
    return {
      templates: templates.map((t) => ({
        id: t.id,
        title: t.title,
        version: t.version,
      })),
      professionals,
      defaultProfessionalId:
        actor.clinical && professionals.some((p) => p.id === actor.userId)
          ? actor.userId
          : null,
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
    if (input.type !== SignatureRequestType.CONSENT) {
      throw new BadRequestException(SIGNATURE_BUDGET_NOT_AVAILABLE_MESSAGE);
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
    for (const id of created.supersededIds) {
      await this.cancelPendingEmail(id);
    }

    // La solicitud ya está guardada: un fallo del outbox no la convierte en
    // un 500 (un reintento duplicaría el envío); la ficha lo dice y se puede
    // anular y enviar otra. Nunca se registra la URL ni el destinatario.
    let emailQueued = false;
    try {
      await this.email.sendLink({
        to: recipient.email,
        referenceId: created.id,
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
