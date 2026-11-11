import type { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { describeDeliveryError } from '../../../notifications/email/application/retry-policy';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import { whatsAppDigits } from '../../../../shared/phone/phone-number';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import {
  noticeRecipient,
  type NoticeRecipient,
} from '../../../patients/domain/communication/notice-recipient';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { maskEmail } from '../../../../shared/privacy/mask-email';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  PostOpDelivery,
  PostOpDeliveryChannel,
} from '../../domain/entities/post-op-delivery.entity';
import {
  POST_OP_DELIVERY_REPOSITORY,
  type PostOpAppointmentContext,
  type PostOpDeliveryDocumentView,
  type PostOpDeliveryRepository,
  type PostOpEmailStatus,
  PostOpDeliveryAlreadyExistsError,
} from '../../domain/ports/post-op-delivery-repository.port';
import {
  POST_OP_TEMPLATE_REPOSITORY,
  type PostOpTemplateRepository,
  type PostOpTemplateView,
} from '../../domain/ports/post-op-template-repository.port';
import {
  buildPostOpUrl,
  generatePostOpToken,
  hashPostOpToken,
  postOpLinkExpiry,
} from '../../domain/postop-token';
import { postOpWhatsAppMessage } from '../../domain/postop-whatsapp-message';
import {
  renderInstructions,
  usesVariable,
} from '../../domain/render-instructions';
import { suggestTemplates } from '../../domain/template-rules';
import { POSTOP_CLOCK, type PostOpClock } from '../post-op-clock';
import {
  POSTOP_EMAIL_EVIDENCE_CUTOFF,
  POSTOP_EMAIL_SENDER,
  type PostOpEmailEvidenceCutoff,
  type PostOpEmailSender,
} from '../postop-email';
import { idempotentDeliveryId } from '../../domain/idempotent-delivery-id';
import { POSTOP_TEMPLATE_NOT_FOUND_MESSAGE } from './post-op-templates.use-cases';

export const POSTOP_APPOINTMENT_NOT_FOUND_MESSAGE = 'Cita no encontrada';
export const POSTOP_TEMPLATE_INACTIVE_MESSAGE = 'La plantilla está inactiva';
export const POSTOP_NO_EMAIL_MESSAGE =
  'El paciente no tiene email ni un responsable que reciba avisos';
export const POSTOP_OPTED_OUT_MESSAGE = 'El paciente dio de baja los envíos';
export const POSTOP_NO_WHATSAPP_MESSAGE =
  'El paciente no tiene un teléfono que sirva para WhatsApp: escríbelo con + y su prefijo';
export const POSTOP_INVALID_HOST_MESSAGE = 'Host no válido';
export const POSTOP_APPOINTMENT_NOT_ATTENDED_MESSAGE =
  'No se pueden entregar indicaciones de una cita cancelada o en la que el paciente no asistió';
export const POSTOP_APPOINTMENT_FUTURE_MESSAGE =
  'No se pueden entregar indicaciones de una cita que aún no ha llegado';
export const POSTOP_IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'Esta clave de idempotencia ya se usó para otra entrega (otra plantilla u otro canal). Vuelve a entregar para generar una clave nueva.';
export const POSTOP_DELIVERY_IN_PROGRESS_MESSAGE =
  'La entrega se está registrando; espera unos segundos y vuelve a consultar';
/** Una entrega EMAIL tan reciente aún puede estar encolando su email. */
const IN_PROGRESS_GRACE_MS = 30_000;
export const POSTOP_DELIVERY_NOT_FOUND_MESSAGE =
  'Entrega de indicaciones no encontrada';

/** Una entrega tal como la ven la cita y la ficha (sin texto ni token). */
export interface PostOpDeliverySummary {
  id: string;
  patientId: string;
  appointmentId: string;
  templateId: string;
  templateCode: string;
  templateTitle: string;
  templateVersion: number;
  channel: PostOpDeliveryChannel;
  deliveredAt: Date;
  deliveredByName: string;
  recipientMasked: string | null;
  sentToResponsible: boolean;
  firstOpenedAt: Date | null;
  /** Caducidad del enlace público; null en una entrega impresa. */
  linkExpiresAt: Date | null;
  /**
   * DX-250: qué pasó con el email (solo en una entrega EMAIL; null en las
   * demás). `NOT_SENT`: nunca se encoló o el outbox se rindió.
   */
  emailStatus: PostOpEmailStatus | null;
}

export type PostOpDeliveryDocument = PostOpDeliverySummary & {
  renderedText: string;
  clinic: PostOpDeliveryDocumentView['clinic'];
  locationName: string;
  locationPhone: string | null;
  regional: DocumentRegionalDto | null;
  patientName: string;
};

export interface PostOpTemplateSummary {
  id: string;
  code: string;
  title: string;
  version: number;
}

export interface PostOpSuggestions {
  patientId: string;
  suggested: PostOpTemplateSummary[];
  others: PostOpTemplateSummary[];
  email: {
    allowed: boolean;
    reason: string | null;
    toMasked: string | null;
    toResponsible: boolean;
  };
  whatsapp: { phone: string | null; reason: string | null };
  locationPhone: string | null;
  deliveries: PostOpDeliverySummary[];
}

export interface DeliverPostOpInput {
  templateId: string;
  channel: PostOpDeliveryChannel;
  /**
   * DX-250: `Idempotency-Key` del clic (UUID). La misma clave en la misma cita
   * devuelve la entrega ya registrada en vez de crear otra.
   */
  idempotencyKey?: string | null;
}

export interface PostOpDeliveryCreated {
  delivery: PostOpDeliverySummary;
  /** Enlace público (EMAIL y WHATSAPP_LINK); su token solo viaja aquí. */
  publicUrl: string | null;
  whatsapp: { phone: string; text: string } | null;
  /** Email enmascarado al que se encoló (EMAIL); null si no se encoló. */
  sentTo: string | null;
  sentToResponsible: boolean;
  /**
   * true: el email quedó en el outbox. false en PRINT y WHATSAPP_LINK, y en
   * un EMAIL cuyo encolado falló (la entrega queda registrada: la web avisa y
   * ofrece el enlace o WhatsApp).
   */
  emailQueued: boolean;
}

export function toPostOpDeliverySummary(
  delivery: PostOpDelivery,
  emailStatus: PostOpEmailStatus | null,
): PostOpDeliverySummary {
  return {
    id: delivery.id,
    patientId: delivery.patientId,
    appointmentId: delivery.appointmentId,
    templateId: delivery.templateId,
    templateCode: delivery.templateCode,
    templateTitle: delivery.templateTitle,
    templateVersion: delivery.templateVersion,
    channel: delivery.channel,
    deliveredAt: delivery.deliveredAt,
    deliveredByName: delivery.deliveredByName,
    recipientMasked: delivery.recipientMasked,
    sentToResponsible: delivery.sentToResponsible,
    firstOpenedAt: delivery.firstOpenedAt,
    linkExpiresAt: delivery.tokenExpiresAt,
    emailStatus: delivery.channel === 'EMAIL' ? emailStatus : null,
  };
}

/**
 * Resúmenes de varias entregas con el estado de su email, leído del outbox
 * (una sola consulta). Una entrega EMAIL reciente sin fila en el outbox no se
 * encoló (`NOT_SENT`); una anterior a `evidenceCutoff` pudo salir y haber sido
 * purgada: no se sabe (`null`), nunca se afirma «no enviado».
 */
async function summarize(
  repo: PostOpDeliveryRepository,
  rows: PostOpDelivery[],
  evidenceCutoff: Date,
): Promise<PostOpDeliverySummary[]> {
  const statuses = await repo.emailStatuses(
    rows.filter((r) => r.channel === 'EMAIL').map((r) => r.id),
  );
  return rows.map((r) =>
    toPostOpDeliverySummary(
      r,
      statuses.get(r.id) ??
        (r.deliveredAt.getTime() < evidenceCutoff.getTime()
          ? null
          : 'NOT_SENT'),
    ),
  );
}

function templateSummary(t: PostOpTemplateView): PostOpTemplateSummary {
  return { id: t.id, code: t.code, title: t.title, version: t.version };
}

/** El móvil con solo los 4 últimos dígitos a la vista. */
function maskPhone(e164: string): string {
  return `${'*'.repeat(Math.max(0, e164.length - 4))}${e164.slice(-4)}`;
}

/**
 * DX-128: un paciente dado de baja de los envíos (o con el canal NONE) no
 * recibe nada por email ni por WhatsApp; lo impreso se le entrega en mano.
 */
function optedOut(ctx: PostOpAppointmentContext): boolean {
  return (
    ctx.patient.reminderOptOutAt !== null ||
    ctx.patient.contactChannel === 'NONE'
  );
}

/**
 * Destinatario del email (DX-203): un menor o un paciente sin email, a su
 * responsable que recibe avisos. Lo pide el personal: no es automático.
 */
function emailRecipient(
  ctx: PostOpAppointmentContext,
  now: Date,
): NoticeRecipient {
  return noticeRecipient({
    patient: {
      firstName: ctx.patient.firstName,
      birthDate: ctx.patient.birthDate,
      email: ctx.patient.email,
      emergencyContactName: ctx.patient.emergencyContactName,
    },
    responsibles: ctx.responsibles,
    majorityAge: ctx.majorityAge,
    today: civilDateIn(now, ctx.location.timeZone),
    timeZone: ctx.location.timeZone,
    majorityReview: ctx.majorityReview,
    automatic: false,
  });
}

function whatsAppPhone(ctx: PostOpAppointmentContext): string | null {
  return whatsAppDigits(ctx.patient.phone, ctx.location.defaultPhoneRegion);
}

/**
 * La cita viva de la clínica y en una sede permitida al miembro. SEC-045
 * (DX-089): una cita de otra sede es 403, como `GET /appointments/:id`, antes
 * de leer sus canales o registrar, enviar o enlazar nada.
 */
async function loadAppointment(
  repo: PostOpDeliveryRepository,
  tenantContext: TenantContextService,
  appointmentId: string,
): Promise<PostOpAppointmentContext> {
  const ctx = await repo.loadAppointmentContext(appointmentId);
  if (!ctx) throw new NotFoundException(POSTOP_APPOINTMENT_NOT_FOUND_MESSAGE);
  tenantContext.assertLocationAllowed(ctx.appointment.locationId);
  return ctx;
}

/**
 * DX-250: las indicaciones se entregan tras una cita que se atendió (o que es
 * de hoy). Una cancelada, un no-show o una de un día aún por llegar (en la
 * zona de la sede) no: la historia clínica no registra lo que no pasó.
 */
const ATTENDED_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'ARRIVED',
  'IN_CHAIR',
  'READY_FOR_CHECKOUT',
]);

function assertAttendable(ctx: PostOpAppointmentContext, now: Date): void {
  const { appointment, location } = ctx;
  if (appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW') {
    throw new UnprocessableEntityException(
      POSTOP_APPOINTMENT_NOT_ATTENDED_MESSAGE,
    );
  }
  // Una cita que ya se atiende (o se atendió) no es «futura» aunque su fecha
  // lo parezca (reagendada, reloj mal puesto): la HC debe poder registrarlo.
  if (ATTENDED_STATUSES.has(appointment.status)) return;
  if (
    civilDateIn(appointment.start, location.timeZone) >
    civilDateIn(now, location.timeZone)
  ) {
    throw new UnprocessableEntityException(POSTOP_APPOINTMENT_FUTURE_MESSAGE);
  }
}

@Injectable()
export class GetPostOpSuggestionsUseCase {
  constructor(
    @Inject(POST_OP_DELIVERY_REPOSITORY)
    private readonly deliveries: PostOpDeliveryRepository,
    @Inject(POST_OP_TEMPLATE_REPOSITORY)
    private readonly templates: PostOpTemplateRepository,
    @Inject(POSTOP_CLOCK) private readonly now: PostOpClock,
    private readonly tenantContext: TenantContextService,
    @Inject(POSTOP_EMAIL_EVIDENCE_CUTOFF)
    private readonly evidenceCutoff: PostOpEmailEvidenceCutoff,
  ) {}

  /**
   * Plantillas activas sugeridas para la cita (por su tipo o por un
   * procedimiento hecho en ella) y el resto, si se puede enviar por email o
   * WhatsApp (y por qué no) y lo ya entregado en la cita.
   */
  async execute(appointmentId: string): Promise<PostOpSuggestions> {
    const ctx = await loadAppointment(
      this.deliveries,
      this.tenantContext,
      appointmentId,
    );
    const { appointment, location } = ctx;
    const [templates, performed, delivered] = await Promise.all([
      this.templates.list({ active: true }),
      this.deliveries.performedCatalogItemIds({
        appointmentId,
        patientId: appointment.patientId,
        day: civilDateIn(appointment.start, location.timeZone),
        timeZone: location.timeZone,
      }),
      this.deliveries.listByAppointment(appointmentId),
    ]);
    const byId = new Map(templates.map((t) => [t.id, t]));
    const split = suggestTemplates({
      templates,
      appointmentTypeId: appointment.appointmentTypeId,
      performedCatalogItemIds: performed,
    });
    const pick = (ids: string[]) =>
      ids.map((id) => templateSummary(byId.get(id)!));

    return {
      patientId: appointment.patientId,
      suggested: pick(split.suggested),
      others: pick(split.others),
      email: this.emailChannel(ctx),
      whatsapp: this.whatsAppChannel(ctx),
      locationPhone: location.phone,
      deliveries: await summarize(
        this.deliveries,
        delivered,
        this.evidenceCutoff(),
      ),
    };
  }

  private emailChannel(
    ctx: PostOpAppointmentContext,
  ): PostOpSuggestions['email'] {
    const blocked = {
      allowed: false,
      toMasked: null,
      toResponsible: false,
    } as const;
    if (optedOut(ctx)) return { ...blocked, reason: POSTOP_OPTED_OUT_MESSAGE };
    const recipient = emailRecipient(ctx, this.now());
    if (!recipient.email) {
      return { ...blocked, reason: POSTOP_NO_EMAIL_MESSAGE };
    }
    return {
      allowed: true,
      reason: null,
      toMasked: maskEmail(recipient.email),
      toResponsible: recipient.kind === 'RESPONSIBLE',
    };
  }

  private whatsAppChannel(
    ctx: PostOpAppointmentContext,
  ): PostOpSuggestions['whatsapp'] {
    if (optedOut(ctx)) return { phone: null, reason: POSTOP_OPTED_OUT_MESSAGE };
    const phone = whatsAppPhone(ctx);
    return phone
      ? { phone, reason: null }
      : { phone: null, reason: POSTOP_NO_WHATSAPP_MESSAGE };
  }
}

/** Lo que cada canal decide antes de registrar la entrega. */
interface ChannelPlan {
  recipientMasked: string | null;
  sentToResponsible: boolean;
  email: { to: string; responsibleName: string | null } | null;
  whatsappPhone: string | null;
  withLink: boolean;
}

@Injectable()
export class DeliverPostOpInstructionsUseCase {
  private readonly logger = new Logger('PostOpInstructions');

  constructor(
    @Inject(POST_OP_DELIVERY_REPOSITORY)
    private readonly deliveries: PostOpDeliveryRepository,
    @Inject(POST_OP_TEMPLATE_REPOSITORY)
    private readonly templates: PostOpTemplateRepository,
    @Inject(POSTOP_EMAIL_SENDER) private readonly email: PostOpEmailSender,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(POSTOP_CLOCK) private readonly now: PostOpClock,
    private readonly tenantContext: TenantContextService,
    @Inject(POSTOP_EMAIL_EVIDENCE_CUTOFF)
    private readonly evidenceCutoff: PostOpEmailEvidenceCutoff,
  ) {}

  /**
   * Registra la entrega con el texto ya renderizado (queda congelado con la
   * versión de la plantilla) y, según el canal: nada más (PRINT), encola el
   * email con el enlace (EMAIL) o devuelve el número y el mensaje de WhatsApp
   * (WHATSAPP_LINK). Ningún rechazo deja una entrega a medias: todo lo que
   * puede fallar se comprueba antes de escribir. El token en claro solo sale
   * en `publicUrl`; se guarda su hash.
   */
  async execute(
    appointmentId: string,
    input: DeliverPostOpInput,
    request: AuditRequestContext,
    /** `host` null: el de la petición no es seguro para armar un enlace. */
    link: { protocol: string; host: string | null },
  ): Promise<PostOpDeliveryCreated> {
    const ctx = await loadAppointment(
      this.deliveries,
      this.tenantContext,
      appointmentId,
    );
    // DX-250: la misma `Idempotency-Key` (reintento tras un 502 o un tiempo
    // agotado, doble clic, otra pestaña) devuelve la entrega ya registrada.
    const deliveryId = input.idempotencyKey
      ? idempotentDeliveryId(
          request.tenantId,
          appointmentId,
          input.idempotencyKey,
        )
      : undefined;
    if (deliveryId) {
      const existing = await this.deliveries.findById(deliveryId);
      if (existing) return this.replayed(existing, input);
    }
    const template = await this.templates.findById(input.templateId);
    if (!template) {
      throw new NotFoundException(POSTOP_TEMPLATE_NOT_FOUND_MESSAGE);
    }
    if (!template.active) {
      throw new BadRequestException(POSTOP_TEMPLATE_INACTIVE_MESSAGE);
    }
    assertAttendable(ctx, this.now());
    // Solo los canales con enlace dependen del host (lo impreso no).
    const linkHost = input.channel === 'PRINT' ? null : link.host;
    if (input.channel !== 'PRINT' && !linkHost) {
      throw new BadRequestException(POSTOP_INVALID_HOST_MESSAGE);
    }
    const plan = await this.planChannel(input.channel, ctx);

    const token = plan.withLink ? generatePostOpToken() : null;
    const publicUrl =
      token && linkHost ? buildPostOpUrl(link.protocol, linkHost, token) : null;
    const { appointment, patient, location } = ctx;
    const renderedText = renderInstructions(template.body, {
      paciente: `${patient.firstName} ${patient.lastName}`,
      profesional: appointment.providerName,
      clinica: ctx.clinicName,
      telefono_sede: location.phone ?? '',
      // Día civil de la cita en la sede, con su formato (409 si le falta),
      // solo si la plantilla lo pinta.
      fecha: usesVariable(template.body, 'fecha')
        ? requireLocationFormat(location).date(
            appointment.start,
            location.timeZone,
          )
        : '',
    });
    const deliveredByName =
      (await this.deliveries.userName(request.actor.userId)) ?? 'Equipo';

    let delivery: PostOpDelivery;
    try {
      delivery = await this.deliveries.create({
        ...(deliveryId ? { id: deliveryId } : {}),
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        locationId: appointment.locationId,
        templateId: template.id,
        templateCode: template.code,
        templateTitle: template.title,
        templateVersion: template.version,
        channel: input.channel,
        renderedText,
        deliveredById: request.actor.userId,
        deliveredByName,
        recipientMasked: plan.recipientMasked,
        sentToResponsible: plan.sentToResponsible,
        tokenHash: token ? hashPostOpToken(token) : null,
        tokenExpiresAt: token ? postOpLinkExpiry(this.now()) : null,
      });
    } catch (err) {
      // Otra petición con la misma clave ganó la carrera entre la lectura y la
      // inserción: es esa entrega.
      if (deliveryId && err instanceof PostOpDeliveryAlreadyExistsError) {
        const existing = await this.deliveries.findById(deliveryId);
        if (existing) return this.replayed(existing, input);
      }
      throw err;
    }

    const firstName = firstNameOnly(patient.firstName) ?? patient.firstName;
    await this.audit.record({
      tenantId: request.tenantId,
      locationId: appointment.locationId,
      actor: { kind: 'user', ...request.actor },
      action: 'CREATE',
      resourceType: 'POSTOP_DELIVERY',
      resourceId: delivery.id,
      patient: { kind: 'postOpDelivery', id: delivery.id },
      requestId: request.requestId,
      ip: request.ip,
      userAgent: request.userAgent,
      metadata: { reason: input.channel },
    });

    // La entrega ya está guardada: se audita antes de encolar y un fallo del
    // outbox no la convierte en un 500 (se perdería el enlace y un reintento
    // duplicaría la fila). Nunca se registra la URL ni el destinatario.
    let emailQueued = false;
    if (plan.email && publicUrl) {
      try {
        await this.email.send({
          to: plan.email.to,
          referenceId: delivery.id,
          vars: {
            patientFirstName: firstName,
            clinicName: ctx.clinicName,
            locationPhone: location.phone,
            url: publicUrl,
            responsibleName: plan.email.responsibleName,
          },
        });
        emailQueued = true;
      } catch (err) {
        this.logger.warn({
          event: 'postop.email_not_enqueued',
          deliveryId: delivery.id,
          error: describeDeliveryError(err),
        });
      }
    }

    return {
      delivery: toPostOpDeliverySummary(
        delivery,
        emailQueued ? 'QUEUED' : 'NOT_SENT',
      ),
      publicUrl,
      whatsapp:
        plan.whatsappPhone && publicUrl
          ? {
              phone: plan.whatsappPhone,
              text: postOpWhatsAppMessage({
                firstName,
                clinicName: ctx.clinicName,
                url: publicUrl,
              }),
            }
          : null,
      sentTo: plan.email && emailQueued ? maskEmail(plan.email.to) : null,
      sentToResponsible: plan.sentToResponsible,
      emailQueued,
    };
  }

  /**
   * La entrega que ya existía para esta `Idempotency-Key`. El enlace público
   * no se puede recuperar (solo se guarda su hash): `publicUrl` y `whatsapp`
   * van a null. El email no se vuelve a encolar (el outbox deduplica por
   * `referenceId`): `emailQueued` sale del estado real del outbox.
   */
  private async replayed(
    existing: PostOpDelivery,
    input: DeliverPostOpInput,
  ): Promise<PostOpDeliveryCreated> {
    // La misma clave solo repite LA MISMA petición (como en los abonos, DX-109).
    if (
      existing.templateId !== input.templateId ||
      existing.channel !== input.channel
    ) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: POSTOP_IDEMPOTENCY_KEY_REUSED_MESSAGE,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    const [summary] = await summarize(
      this.deliveries,
      [existing],
      this.evidenceCutoff(),
    );
    // La primera petición puede estar entre el INSERT y el encolado del email:
    // un EMAIL tan reciente sin fila en el outbox no se da por «no enviado».
    if (
      existing.channel === 'EMAIL' &&
      summary.emailStatus === 'NOT_SENT' &&
      this.now().getTime() - existing.deliveredAt.getTime() <
        IN_PROGRESS_GRACE_MS
    ) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: POSTOP_DELIVERY_IN_PROGRESS_MESSAGE,
        code: 'POSTOP_DELIVERY_IN_PROGRESS',
      });
    }
    const emailQueued =
      summary.emailStatus === 'QUEUED' || summary.emailStatus === 'SENT';
    return {
      delivery: summary,
      publicUrl: null,
      whatsapp: null,
      sentTo: emailQueued ? existing.recipientMasked : null,
      sentToResponsible: existing.sentToResponsible,
      emailQueued,
    };
  }

  private async planChannel(
    channel: PostOpDeliveryChannel,
    ctx: PostOpAppointmentContext,
  ): Promise<ChannelPlan> {
    if (channel === 'PRINT') {
      return {
        recipientMasked: null,
        sentToResponsible: false,
        email: null,
        whatsappPhone: null,
        withLink: false,
      };
    }
    if (optedOut(ctx)) {
      throw new UnprocessableEntityException(POSTOP_OPTED_OUT_MESSAGE);
    }
    if (channel === 'WHATSAPP_LINK') {
      const phone = whatsAppPhone(ctx);
      if (!phone) {
        throw new UnprocessableEntityException(POSTOP_NO_WHATSAPP_MESSAGE);
      }
      return {
        recipientMasked: maskPhone(phone),
        sentToResponsible: false,
        email: null,
        whatsappPhone: phone,
        withLink: true,
      };
    }
    const recipient = emailRecipient(ctx, this.now());
    if (!recipient.email) {
      throw new UnprocessableEntityException(POSTOP_NO_EMAIL_MESSAGE);
    }
    await this.email.assertCanSend(recipient.email);
    const toResponsible = recipient.kind === 'RESPONSIBLE';
    return {
      recipientMasked: maskEmail(recipient.email),
      sentToResponsible: toResponsible,
      email: {
        to: recipient.email,
        responsibleName: toResponsible ? recipient.name : null,
      },
      whatsappPhone: null,
      withLink: true,
    };
  }
}

@Injectable()
export class ListPatientPostOpDeliveriesUseCase {
  constructor(
    @Inject(POST_OP_DELIVERY_REPOSITORY)
    private readonly deliveries: PostOpDeliveryRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(POSTOP_EMAIL_EVIDENCE_CUTOFF)
    private readonly evidenceCutoff: PostOpEmailEvidenceCutoff,
  ) {}

  /** Entregas del paciente, las más recientes primero. */
  async execute(patientId: string): Promise<PostOpDeliverySummary[]> {
    await assertPatientInClinic(this.patients, patientId);
    const rows = await this.deliveries.listByPatient(patientId);
    return summarize(this.deliveries, rows, this.evidenceCutoff());
  }
}

@Injectable()
export class GetPatientPostOpDeliveryUseCase {
  constructor(
    @Inject(POST_OP_DELIVERY_REPOSITORY)
    private readonly deliveries: PostOpDeliveryRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(POSTOP_EMAIL_EVIDENCE_CUTOFF)
    private readonly evidenceCutoff: PostOpEmailEvidenceCutoff,
  ) {}

  /** La entrega con su texto congelado, para verla o reimprimirla. */
  async execute(
    patientId: string,
    id: string,
  ): Promise<PostOpDeliveryDocument> {
    await assertPatientInClinic(this.patients, patientId);
    const view = await this.deliveries.findForPatient(patientId, id);
    if (!view) throw new NotFoundException(POSTOP_DELIVERY_NOT_FOUND_MESSAGE);
    const [summary] = await summarize(
      this.deliveries,
      [view],
      this.evidenceCutoff(),
    );
    return {
      ...summary,
      renderedText: view.renderedText,
      clinic: view.clinic,
      locationName: view.locationName,
      locationPhone: view.locationPhone,
      regional: view.regional,
      patientName: view.patientName,
    };
  }
}
