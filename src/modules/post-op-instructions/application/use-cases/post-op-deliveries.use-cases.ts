import {
  BadRequestException,
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
import { toWhatsAppNumber } from '../../../appointment-confirmations/application/whatsapp-phone';
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
import { renderInstructions } from '../../domain/render-instructions';
import { suggestTemplates } from '../../domain/template-rules';
import { POSTOP_CLOCK, type PostOpClock } from '../post-op-clock';
import { POSTOP_EMAIL_SENDER, type PostOpEmailSender } from '../postop-email';
import { POSTOP_TEMPLATE_NOT_FOUND_MESSAGE } from './post-op-templates.use-cases';

export const POSTOP_APPOINTMENT_NOT_FOUND_MESSAGE = 'Cita no encontrada';
export const POSTOP_TEMPLATE_INACTIVE_MESSAGE = 'La plantilla está inactiva';
export const POSTOP_NO_EMAIL_MESSAGE =
  'El paciente no tiene email ni un responsable que reciba avisos';
export const POSTOP_OPTED_OUT_MESSAGE = 'El paciente dio de baja los envíos';
export const POSTOP_NO_WHATSAPP_MESSAGE =
  'El paciente no tiene un teléfono con indicativo de país';
export const POSTOP_INVALID_HOST_MESSAGE = 'Host no válido';
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
}

export type PostOpDeliveryDocument = PostOpDeliverySummary & {
  renderedText: string;
  clinic: PostOpDeliveryDocumentView['clinic'];
  locationName: string;
  locationPhone: string | null;
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
  };
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
    country: ctx.location.country,
    today: civilDateIn(now, ctx.location.timeZone),
    automatic: false,
  });
}

function whatsAppPhone(ctx: PostOpAppointmentContext): string | null {
  return toWhatsAppNumber(ctx.patient.phone, ctx.location.country);
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

@Injectable()
export class GetPostOpSuggestionsUseCase {
  constructor(
    @Inject(POST_OP_DELIVERY_REPOSITORY)
    private readonly deliveries: PostOpDeliveryRepository,
    @Inject(POST_OP_TEMPLATE_REPOSITORY)
    private readonly templates: PostOpTemplateRepository,
    @Inject(POSTOP_CLOCK) private readonly now: PostOpClock,
    private readonly tenantContext: TenantContextService,
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
      deliveries: delivered.map(toPostOpDeliverySummary),
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
    const template = await this.templates.findById(input.templateId);
    if (!template) {
      throw new NotFoundException(POSTOP_TEMPLATE_NOT_FOUND_MESSAGE);
    }
    if (!template.active) {
      throw new BadRequestException(POSTOP_TEMPLATE_INACTIVE_MESSAGE);
    }
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
      // Día civil de la cita en la sede, con su formato (409 si le falta).
      fecha: requireLocationFormat(location).date(
        appointment.start,
        location.timeZone,
      ),
    });
    const deliveredByName =
      (await this.deliveries.userName(request.actor.userId)) ?? 'Equipo';

    const delivery = await this.deliveries.create({
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
      delivery: toPostOpDeliverySummary(delivery),
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
  ) {}

  /** Entregas del paciente, las más recientes primero. */
  async execute(patientId: string): Promise<PostOpDeliverySummary[]> {
    await assertPatientInClinic(this.patients, patientId);
    const rows = await this.deliveries.listByPatient(patientId);
    return rows.map(toPostOpDeliverySummary);
  }
}

@Injectable()
export class GetPatientPostOpDeliveryUseCase {
  constructor(
    @Inject(POST_OP_DELIVERY_REPOSITORY)
    private readonly deliveries: PostOpDeliveryRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  /** La entrega con su texto congelado, para verla o reimprimirla. */
  async execute(
    patientId: string,
    id: string,
  ): Promise<PostOpDeliveryDocument> {
    await assertPatientInClinic(this.patients, patientId);
    const view = await this.deliveries.findForPatient(patientId, id);
    if (!view) throw new NotFoundException(POSTOP_DELIVERY_NOT_FOUND_MESSAGE);
    return {
      ...toPostOpDeliverySummary(view),
      renderedText: view.renderedText,
      clinic: view.clinic,
      locationName: view.locationName,
      locationPhone: view.locationPhone,
      patientName: view.patientName,
    };
  }
}
