import type {
  AppointmentConfirmationResponse,
  AppointmentStatus,
} from '@prisma/client';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditMetadata } from '../../audit/domain/audit-metadata';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../audit/domain/audit-request-context';
import type { CancellationNotice } from '../../cancellation-policies/domain/cancellation-policy';

/**
 * DX-361: eventos del enlace de confirmación de cita. Todos son un UPDATE de
 * la cita (`resourceId`, y el paciente sale de ella bajo RLS); el `reason`
 * dice qué pasó y el `origin` quién: el personal (STAFF, con su usuario) o el
 * paciente desde el enlace (LINK, sin usuario). Nunca el token, su hash ni la
 * URL: no hay forma de llegar al enlace desde el registro.
 */
export const CONFIRMATION_LINK_REASONS = {
  CREATED: 'CONFIRMATION_LINK_CREATED',
  RESENT: 'CONFIRMATION_LINK_RESENT',
  CONFIRM: 'CONFIRMATION_LINK_CONFIRMED',
  CANCEL: 'CONFIRMATION_LINK_CANCELLED',
  CALL_ME: 'CONFIRMATION_LINK_CALL_REQUESTED',
} as const;

/** Estado al que lleva cada respuesta (CALL_ME no lo cambia). */
const STATUS_AFTER: Record<
  AppointmentConfirmationResponse,
  AppointmentStatus | null
> = {
  CONFIRM: 'CONFIRMED',
  CANCEL: 'CANCELLED',
  CALL_ME: null,
};

/**
 * Recepción genera el enlace (`resent` = la cita ya tenía uno enviado, el
 * botón «Reenviar» de la agenda). La sede del evento es la de la cita.
 */
export function confirmationLinkAuditEvent(
  ctx: AuditRequestContext,
  appointment: { id: string; locationId: string },
  resent: boolean,
): AuditEventDraft {
  return {
    tenantId: ctx.tenantId,
    locationId: appointment.locationId,
    actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
    action: 'UPDATE',
    resourceType: 'APPOINTMENT',
    resourceId: appointment.id,
    patient: { kind: 'appointment', id: appointment.id },
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: {
      origin: 'STAFF',
      reason: resent
        ? CONFIRMATION_LINK_REASONS.RESENT
        : CONFIRMATION_LINK_REASONS.CREATED,
    },
  };
}

export interface ConfirmationResponseAudit {
  /** El de la cita resuelta por el token (contexto del host), nunca del cliente. */
  tenantId: string;
  appointmentId: string;
  locationId: string;
  response: AppointmentConfirmationResponse;
  /** Estado de la cita al responder (el que tenía al emitir el enlace). */
  statusBefore: AppointmentStatus;
  /** Solo al cancelar: minutos de aviso y si fue tardía (DX-291). */
  notice: CancellationNotice | null;
}

/** El paciente responde desde el enlace: confirmar, cancelar o «llamarme». */
export function confirmationResponseAuditEvent(
  request: AuditRequestMeta | null,
  input: ConfirmationResponseAudit,
): AuditEventDraft {
  const after = STATUS_AFTER[input.response];
  const metadata: AuditMetadata = {
    origin: 'LINK',
    reason: CONFIRMATION_LINK_REASONS[input.response],
  };
  if (after && after !== input.statusBefore) {
    metadata.status = { from: input.statusBefore, to: after };
  }
  if (input.response === 'CANCEL' && input.notice) {
    metadata.cancellation = {
      byKind: 'PATIENT_LINK',
      reasonCode: null,
      noticeMinutes: input.notice.noticeMinutes,
      lateCancellation: input.notice.lateCancellation,
    };
  }
  return {
    tenantId: input.tenantId,
    locationId: input.locationId,
    actor: { kind: 'patient' },
    action: 'UPDATE',
    resourceType: 'APPOINTMENT',
    resourceId: input.appointmentId,
    patient: { kind: 'appointment', id: input.appointmentId },
    requestId: request?.requestId ?? null,
    ip: request?.ip ?? null,
    userAgent: request?.userAgent ?? null,
    metadata,
  };
}
