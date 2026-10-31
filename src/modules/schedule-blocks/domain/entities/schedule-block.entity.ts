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
  /**
   * DX-446: tipos de cita que SÍ caben en un bloque `RESERVED` (vacío en los
   * demás tipos).
   */
  reservedForTypeIds: string[];
  /**
   * DX-446: «Liberar a partir de», minutos desde las 00:00 de pared de la sede
   * del día del bloque (0..1439). `null` = no se libera. Solo en `RESERVED`.
   */
  releaseAtMinute: number | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** DX-446: lo que la agenda necesita de un tipo de cita reservado. */
export interface ReservedTypeRef {
  id: string;
  name: string;
  color: string;
  isUrgent: boolean;
  active: boolean;
}

/**
 * DX-446: un bloque tal como lo pinta la agenda: con los tipos reservados
 * (nombre y color), el instante de liberación de su día y si ya se liberó
 * (reloj del servidor, zona de la sede).
 */
export interface ScheduleBlockView extends ScheduleBlock {
  reservedForTypes: ReservedTypeRef[];
  releaseAt: Date | null;
  released: boolean;
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
