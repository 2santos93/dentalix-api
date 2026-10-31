import {
  AppointmentStatus,
  CancellationByKind,
  CancellationReasonCode,
  TriageFlag,
} from '@prisma/client';
import type { AppointmentTypeSummary } from '../../../appointment-types/domain/entities/appointment-type.entity';
import type { HourCycle } from '../../../../shared/format/regional-format';

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
  /**
   * DX-279: cancelación (solo en CANCELLED; null en las canceladas antiguas):
   * hora del servidor, quién (enlace del paciente, el personal por el
   * paciente o la clínica), motivo del catálogo y texto opcional, minutos de
   * aviso y si fue tardía según la política vigente de su sede.
   */
  cancelledAt: Date | null;
  cancelledByKind: CancellationByKind | null;
  cancelReasonCode: CancellationReasonCode | null;
  cancelReasonText: string | null;
  noticeMinutes: number | null;
  lateCancellation: boolean | null;
  /** DX-279: cuándo se marcó la inasistencia (solo en NO_SHOW). */
  noShowMarkedAt: Date | null;
  /** DX-279: versión de la política comunicada al paciente (DX-291; hoy null). */
  policyVersionId: string | null;
  /**
   * DX-470: señales y nota de triaje de recepción (datos de salud). Solo las
   * devuelven GET /appointments/:id y el panel «En clínica»; la agenda, las
   * vistas públicas y los recordatorios no.
   */
  triageFlags: TriageFlag[];
  triageNote: string | null;
  /** DX-470: nació en «Atender sin cita». */
  walkIn: boolean;
  /** DX-470: sobrecupo anotado (no ocupa el hueco del profesional). */
  overbooked: boolean;
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
  /**
   * DX-273 (revisión DX-271, I2): tratamientos de esta cita que siguen
   * reservados en OTRA cita viva (la reserva se quedó allí al marcar «Llegó»).
   * Solo citas de sedes permitidas al usuario (DX-089), salvo una de hoy con
   * el paciente en la clínica, que sale sin sus datos (DX-293). Vacío si no
   * hay.
   */
  planItemsReservedElsewhere: PlanItemReservedElsewhere[];
  /**
   * DX-273: solo al sacar la cita de COMPLETED. El motivo y cómo queda el
   * intervalo mínimo de la visita siguiente de cada plan afectado.
   */
  completedExit?: CompletedExit;
  /**
   * DX-446: la cita se agendó o movió a un hueco reservado saltándose la
   * reserva (con permiso y motivo): los bloques y el motivo (este en
   * `appointment_reserved_overrides`, nunca en `audit_event`). Ausente en cualquier otro caso.
   */
  reservedOverride?: { blockIds: string[]; reason: string };
}

/** Un tratamiento de la cita reservado en otra cita (DX-273). */
export interface PlanItemReservedElsewhere {
  planItemId: string;
  /** Nombre del procedimiento (catálogo, en español). */
  name: string;
  toothNumber: string;
  /**
   * DX-293: la cita que lo reserva es de hoy (día civil de su sede) con el
   * paciente en la clínica. «Traer a esta cita» daría el 409 de DX-288.
   */
  heldInClinic: boolean;
  /**
   * La cita que lo reserva, su inicio, su sede y la zona de esa sede (la
   * fecha se muestra en ella). `null` todos si esa sede no está permitida al
   * usuario (DX-089): solo ocurre con `heldInClinic`.
   */
  appointmentId: string | null;
  start: Date | null;
  locationId: string | null;
  locationName: string | null;
  timeZone: string | null;
  /**
   * G1-B (spec §4.4, pre-flight I4): formato y reloj de esa sede EN CRUDO,
   * como la columna: `null` si la sede no está permitida y también si no
   * tiene el dato. La API no formatea con ellos y la lectura no falla.
   */
  locale: string | null;
  hourCycle: HourCycle | null;
}

/**
 * Intervalo mínimo de una visita del plan antes y después de sacar de
 * COMPLETED la cita de la visita anterior (DX-273). Día civil YYYY-MM-DD en la
 * zona de la sede del plan, como `GET /treatment-plans/:id/visits`; `null` =
 * sin mínimo clínico (ninguna cita de la visita anterior sigue completada, o
 * el intervalo es 0): se puede agendar desde hoy.
 */
export interface VisitMinimumChange {
  planId: string;
  visit: number;
  minimumDayBefore: string | null;
  minimumDayAfter: string | null;
  /** La cita completada que fija ahora el mínimo, o `null` si ninguna. */
  anchorAppointmentIdAfter: string | null;
}

/** Resultado de sacar una cita de COMPLETED (DX-273). */
export interface CompletedExit {
  /** Fila de `appointment_status_reversals` con el motivo. */
  reversalId: string;
  reason: string;
  visitMinimums: VisitMinimumChange[];
}

/** Códigos de `AppointmentWriteResult.warningCodes`. */
export const APPOINTMENT_WARNING_CODES = [
  'SCHEDULE_BLOCK',
  'PROVIDER_OFF_SCHEDULE',
] as const;
export type AppointmentWarningCode = (typeof APPOINTMENT_WARNING_CODES)[number];
