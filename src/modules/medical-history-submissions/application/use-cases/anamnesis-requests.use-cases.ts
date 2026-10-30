import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { MedicalHistorySubmissionStatus } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import { whatsAppDigits } from '../../../../shared/phone/phone-number';
import { NO_POLICY_MESSAGE } from '../../../data-consents/infrastructure/record-consents-in-tx';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import { ANAMNESIS_QUESTIONNAIRE_VERSION } from '../../domain/anamnesis-questionnaire';
import {
  anamnesisLinkExpiry,
  buildAnamnesisUrl,
  generateAnamnesisToken,
  hashAnamnesisToken,
} from '../../domain/anamnesis-token';
import { anamnesisWhatsAppMessage } from '../../domain/anamnesis-whatsapp-message';
import type { SubmissionSummary } from '../../domain/entities/medical-history-submission.entity';
import {
  MEDICAL_HISTORY_SUBMISSION_REPOSITORY,
  type MedicalHistorySubmissionRepository,
  type ReviewOutcome,
} from '../../domain/ports/medical-history-submission-repository.port';
import { effectiveSubmissionStatus } from '../../domain/submission-status';
import { ANAMNESIS_CLOCK, type AnamnesisClock } from '../anamnesis-clock';

export const ANAMNESIS_APPOINTMENT_NOT_FOUND_MESSAGE = 'Cita no encontrada';
export const ANAMNESIS_APPOINTMENT_OTHER_PATIENT_MESSAGE =
  'La cita no es de este paciente.';
export const ANAMNESIS_APPOINTMENT_STARTED_MESSAGE =
  'La cita ya empezó: el enlace nacería caducado.';
export const ANAMNESIS_APPOINTMENT_NOT_SCHEDULED_MESSAGE =
  'La cita no está agendada: envía la anamnesis sin cita o elige otra.';
export const ANAMNESIS_INVALID_HOST_MESSAGE = 'Host no válido';
export const ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE = 'Anamnesis no encontrada';
export const ANAMNESIS_NOT_PENDING_MESSAGE =
  'Este enlace ya no espera respuesta del paciente: no hay nada que anular.';
export const ANAMNESIS_OPTED_OUT_MESSAGE =
  'El paciente dio de baja los envíos: comparte el enlace por otro medio.';
export const ANAMNESIS_NO_WHATSAPP_MESSAGE =
  'El paciente no tiene un teléfono que sirva para WhatsApp: escríbelo con + y su prefijo.';

/** Historial de la ficha: los últimos envíos del paciente. */
export const PATIENT_REQUESTS_LIMIT = 10;
/** Tope de la bandeja (una clínica no acumula más sin revisar). */
export const INBOX_LIMIT = 200;

const SCHEDULABLE = new Set(['SCHEDULED', 'CONFIRMED']);

export interface CreatedAnamnesisRequest {
  id: string;
  patientId: string;
  appointmentId: string | null;
  /** Enlace público: el token solo viaja aquí, una vez. */
  url: string;
  expiresAt: Date;
  whatsapp: { phone: string; text: string } | null;
  /** Por qué no hay WhatsApp (sin teléfono, baja de envíos); `null` si lo hay. */
  whatsappUnavailableReason: string | null;
  /** El formulario pedirá antes la autorización SENSITIVE_HEALTH. */
  consentRequired: boolean;
}

/** Fila de la ficha o de la bandeja, con el estado efectivo (caducado por la hora). */
export type SubmissionListItem = SubmissionSummary;

export function withEffectiveStatus(
  summary: SubmissionSummary,
  now: Date,
): SubmissionListItem {
  return { ...summary, status: effectiveSubmissionStatus(summary, now) };
}

/** Traduce el resultado de una revisión o anulación a la respuesta HTTP. */
export function unwrapReview(
  outcome: ReviewOutcome,
  conflictMessage: (status: MedicalHistorySubmissionStatus) => string,
) {
  if (outcome.kind === 'NOT_FOUND') {
    throw new NotFoundException(ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE);
  }
  if (outcome.kind === 'CONFLICT') {
    throw new ConflictException(conflictMessage(outcome.status));
  }
  return outcome.submission;
}

/**
 * `POST /patients/:patientId/medical-history/requests` (DX-099): emite el
 * enlace al cuestionario de salud. Lo puede hacer recepción. Caduca a los 7
 * días o al inicio de la cita, sirve una sola vez y anula el anterior que aún
 * esperaba respuesta. Devuelve la URL UNA vez (solo se guarda el hash).
 */
@Injectable()
export class CreateAnamnesisRequestUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  async execute(
    patientId: string,
    input: { appointmentId?: string },
    createdById: string,
    link: { protocol: string; host: string | null },
  ): Promise<CreatedAnamnesisRequest> {
    const now = this.clock();
    const ctx = await this.repo.loadRequestContext(patientId);
    if (!ctx) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);

    let appointmentStart: Date | null = null;
    let locationId: string | null = null;
    if (input.appointmentId) {
      const appointment = await this.repo.findAppointment(input.appointmentId);
      if (!appointment) {
        throw new NotFoundException(ANAMNESIS_APPOINTMENT_NOT_FOUND_MESSAGE);
      }
      // SEC-045: una cita de otra sede es 403 antes de emitir nada.
      this.tenantContext.assertLocationAllowed(appointment.locationId);
      if (appointment.patientId !== patientId) {
        throw new BadRequestException(
          ANAMNESIS_APPOINTMENT_OTHER_PATIENT_MESSAGE,
        );
      }
      if (!SCHEDULABLE.has(appointment.status)) {
        throw new UnprocessableEntityException(
          ANAMNESIS_APPOINTMENT_NOT_SCHEDULED_MESSAGE,
        );
      }
      if (appointment.start.getTime() <= now.getTime()) {
        throw new UnprocessableEntityException(
          ANAMNESIS_APPOINTMENT_STARTED_MESSAGE,
        );
      }
      appointmentStart = appointment.start;
      locationId = appointment.locationId;
    }
    // Sin autorización vigente el formulario la pedirá con el texto
    // versionado de la clínica: sin política publicada no hay qué pedir.
    if (!ctx.sensitiveHealthGranted && !ctx.hasPrivacyPolicy) {
      throw new ConflictException(NO_POLICY_MESSAGE);
    }
    // Como el enlace de confirmación: el host entero se valida antes de
    // escribir nada; uno manipulado no arma un enlace hacia otro sitio.
    if (!link.host) {
      throw new BadRequestException(ANAMNESIS_INVALID_HOST_MESSAGE);
    }

    const token = generateAnamnesisToken();
    const issued = await this.repo.issue({
      patientId,
      appointmentId: input.appointmentId ?? null,
      locationId,
      tokenHash: hashAnamnesisToken(token),
      expiresAt: anamnesisLinkExpiry(now, appointmentStart),
      questionnaireVersion: ANAMNESIS_QUESTIONNAIRE_VERSION,
      createdById,
    });
    const url = buildAnamnesisUrl(link.protocol, link.host, token);

    const optedOut =
      ctx.patient.reminderOptOutAt !== null ||
      ctx.patient.contactChannel === 'NONE';
    const phone = optedOut
      ? null
      : whatsAppDigits(ctx.patient.phone, issued.locationPhoneRegion);
    return {
      id: issued.submission.id,
      patientId,
      appointmentId: issued.submission.appointmentId,
      url,
      expiresAt: issued.submission.expiresAt,
      whatsapp: phone
        ? {
            phone,
            text: anamnesisWhatsAppMessage({
              firstName: firstNameOnly(ctx.patient.firstName),
              clinicName: ctx.clinicName,
              url,
            }),
          }
        : null,
      whatsappUnavailableReason: phone
        ? null
        : optedOut
          ? ANAMNESIS_OPTED_OUT_MESSAGE
          : ANAMNESIS_NO_WHATSAPP_MESSAGE,
      consentRequired: !ctx.sensitiveHealthGranted,
    };
  }
}

/** `GET /patients/:patientId/medical-history/requests`: lo que ve la ficha. */
@Injectable()
export class ListPatientAnamnesisRequestsUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  /**
   * `clinical` = quien pide ve dato clínico (CLINICAL_ROLES). El motivo del
   * rechazo es texto libre del profesional sobre las respuestas: recepción ve
   * el estado, no el motivo.
   */
  async execute(
    patientId: string,
    viewer: { clinical: boolean },
  ): Promise<SubmissionListItem[]> {
    const ctx = await this.repo.loadRequestContext(patientId);
    if (!ctx) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const now = this.clock();
    const rows = await this.repo.listForPatient(
      patientId,
      PATIENT_REQUESTS_LIMIT,
    );
    return rows.map((r) => {
      const item = withEffectiveStatus(r, now);
      return viewer.clinical ? item : { ...item, rejectReason: null };
    });
  }
}

/** `POST /medical-history/submissions/:id/revoke`: anular un enlace sin usar. */
@Injectable()
export class RevokeAnamnesisRequestUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  async execute(id: string): Promise<SubmissionListItem> {
    const detail = await this.repo.findDetail(id);
    if (!detail) {
      throw new NotFoundException(ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE);
    }
    this.tenantContext.assertLocationAllowed(detail.submission.locationId);
    const now = this.clock();
    unwrapReview(
      await this.repo.revoke({ id, now }),
      () => ANAMNESIS_NOT_PENDING_MESSAGE,
    );
    const fresh = await this.repo.findDetail(id);
    if (!fresh) {
      throw new NotFoundException(ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE);
    }
    return withEffectiveStatus(fresh.summary, now);
  }
}
