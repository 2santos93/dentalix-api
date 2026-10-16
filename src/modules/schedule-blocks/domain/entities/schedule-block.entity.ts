import type { AppointmentStatus, ScheduleBlockKind } from '@prisma/client';

/**
 * Bloqueo de agenda (DX-122). Alcance:
 * - `providerId` y `locationId`: el profesional, solo en esa sede;
 * - `providerId` sin `locationId`: el profesional en TODAS las sedes
 *   (vacaciones, congreso: una persona no está en dos sitios);
 * - sin `providerId` (con `locationId`): toda la sede.
 *
 * `allowsBooking = false` impide agendar encima (409); `true` deja agendar con
 * un aviso en la respuesta (p. ej. el almuerzo).
 */
export interface ScheduleBlock {
  id: string;
  tenantId: string;
  locationId: string | null;
  providerId: string | null;
  /** `[start, end)` medio abierto, como las citas. */
  start: Date;
  end: Date;
  kind: ScheduleBlockKind;
  allowsBooking: boolean;
  note: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Una cita viva que cae dentro de un bloqueo (se lista antes de confirmar). */
export interface AffectedAppointment {
  id: string;
  locationId: string;
  providerId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  patientFirstName: string | null;
  patientLastName: string | null;
}
