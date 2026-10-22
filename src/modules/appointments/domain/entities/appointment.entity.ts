import { AppointmentStatus } from '@prisma/client';
import type { AppointmentTypeSummary } from '../../../appointment-types/domain/entities/appointment-type.entity';

/**
 * API-facing shape of an Appointment. Deliberately NOT the raw Prisma model:
 * repositories must `mapToEntity` before returning across the port boundary
 * (same convention as Patient / ToothRecord).
 */
export interface Appointment {
  planItemIds?: string[];
  id: string;
  tenantId: string;
  /** Sede donde ocurre la cita: su horario es el que vale al reagendarla. */
  locationId: string;
  patientId: string;
  /**
   * Patient's name, joined from `Patient` so a client can label an appointment
   * without fetching the patient list. Before this existed the web app built a
   * `patientId -> name` map from `GET /patients?pageSize=100` — which silently
   * fell back to showing a raw UUID for every patient past the first 100 (the
   * endpoint's hard cap). Null only if the join is unavailable.
   */
  patientFirstName: string | null;
  patientLastName: string | null;
  providerId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  createdById: string | null;
  /** DX-121: tipo de la cita; null en las citas sin tipo. */
  appointmentTypeId: string | null;
  /**
   * DX-121: el tipo embebido (nombre, duración y color) para pintar la tarjeta
   * sin otra petición. Se embebe aunque el tipo se haya desactivado o retirado
   * después: la cita no cambia.
   */
  appointmentType: AppointmentTypeSummary | null;
  /**
   * DX-005: cuándo se generó el enlace de confirmación vigente. null si nunca
   * se envió, o si la cita se reagendó / cambió de estado después (el enlace
   * dejó de valer).
   */
  confirmationSentAt: Date | null;
  /** DX-005: el paciente pidió que lo llamen desde el enlace (la cita sigue SCHEDULED). */
  callbackRequestedAt: Date | null;
  /**
   * DX-210: «Adelantar si hay hueco». La cita sale como candidata para los
   * huecos libres de días anteriores; al moverla a uno se apaga.
   */
  wantsEarlier: boolean;
  /**
   * DX-200: horas del flujo en la clínica (reloj del servidor): llegó, pasó al
   * sillón y quedó listo para cobrar. null en las citas antiguas y mientras no
   * se marca el paso; «Deshacer llegada» borra `arrivedAt`.
   */
  arrivedAt: Date | null;
  seatedAt: Date | null;
  readyForCheckoutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Respuesta de agendar o mover una cita (DX-122): la cita y los avisos que no
 * impiden la operación (p. ej. cae en un bloqueo de almuerzo que deja agendar).
 */
export interface AppointmentWriteResult extends Appointment {
  warnings: string[];
  /**
   * DX-233: el código de cada aviso, en el mismo orden que `warnings`
   * (`SCHEDULE_BLOCK` o `PROVIDER_OFF_SCHEDULE`), para que la web decida
   * cómo pintarlo sin leer el texto.
   */
  warningCodes: AppointmentWarningCode[];
}

/** Códigos de `AppointmentWriteResult.warningCodes`. */
export const APPOINTMENT_WARNING_CODES = [
  'SCHEDULE_BLOCK',
  'PROVIDER_OFF_SCHEDULE',
] as const;
export type AppointmentWarningCode = (typeof APPOINTMENT_WARNING_CODES)[number];
