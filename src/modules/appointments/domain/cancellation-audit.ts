import type {
  CancellationByKind,
  CancellationReasonCode,
} from '@prisma/client';
import type { AuditCancellation } from '../../audit/domain/audit-metadata';

/**
 * DX-279: la cancelación de una cita en la metadata de su `audit_event`
 * (origen, código del motivo, minutos de aviso y si fue tardía; nunca el texto
 * libre). Vacío si la cita no tiene datos de cancelación. Un solo evento por
 * cancelación: lo lleva el de flujo (DX-200), el de salida de «Completada»
 * (DX-273) o, si no hay ninguno, `APPOINTMENT_CANCELLED`.
 */
export function cancellationAuditMetadata(appointment: {
  cancelledByKind: CancellationByKind | null;
  cancelReasonCode: CancellationReasonCode | null;
  noticeMinutes: number | null;
  lateCancellation: boolean | null;
}): { cancellation?: AuditCancellation } {
  if (
    appointment.cancelledByKind === null ||
    appointment.noticeMinutes === null ||
    appointment.lateCancellation === null
  ) {
    return {};
  }
  return {
    cancellation: {
      byKind: appointment.cancelledByKind,
      reasonCode: appointment.cancelReasonCode,
      noticeMinutes: appointment.noticeMinutes,
      lateCancellation: appointment.lateCancellation,
    },
  };
}
