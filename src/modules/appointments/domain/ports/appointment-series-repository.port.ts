import type { ClinicRole, Prisma } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { ReminderContact } from '../../../reminders/domain/reminder-eligibility';
import type {
  NoticePatientFields,
  NoticeResponsible,
} from '../../../patients/domain/communication/notice-recipient';
import type { MajorityReviewRecord } from '../../../patients/domain/responsible-parties/majority-review';
import type { Appointment } from '../entities/appointment.entity';
import type { UpdateAppointmentRepoInput } from './appointment-repository.port';

export const APPOINTMENT_SERIES_REPOSITORY = Symbol(
  'APPOINTMENT_SERIES_REPOSITORY',
);

/** DX-562: una serie con sus citas vivas (sin las retiradas), por posición. */
export interface AppointmentSeriesSnapshot {
  id: string;
  intervalWeeks: number;
  occurrences: number;
  cancelledAt: Date | null;
  appointments: Appointment[];
}

/** DX-562: lo que la serie escribe en cada cita (todas iguales salvo la hora). */
export interface CreateSeriesRepoInput {
  intervalWeeks: number;
  patientId: string;
  providerId: string;
  locationId: string;
  chairId: string | null;
  appointmentTypeId: string | null;
  reason: string | null;
  notes: string | null;
  createdById: string;
  actorRole: ClinicRole | null;
  /** Las citas, en orden de fecha: su posición en la serie es la de aquí (1..n). */
  slots: { start: Date; end: Date }[];
  audit: AuditRequestContext;
  /** El aviso al paciente, insertado en la MISMA transacción (DX-463). */
  email: {
    insert(tx: Prisma.TransactionClient): Promise<{ id: string }>;
  } | null;
}

/**
 * DX-562: una cita de la serie no se pudo escribir dentro de la transacción
 * (bloqueo duro creado a la vez o la EXCLUDE de la BD): se deshace TODO y el
 * caso de uso responde 409 con esa posición.
 */
export class SeriesSlotWriteError extends Error {
  constructor(
    /** Posición en `slots` (0..n-1) o el id de la cita que se movía. */
    readonly at: { position: number } | { appointmentId: string },
    readonly cause: unknown,
  ) {
    super('No se pudo escribir una cita de la serie');
    this.name = 'SeriesSlotWriteError';
  }
}

/** DX-562: una cita de la serie que se cancela o se mueve, con su cambio. */
export interface SeriesAppointmentChange {
  id: string;
  patch: UpdateAppointmentRepoInput;
}

export interface ApplySeriesChangesInput {
  seriesId: string;
  /** En el orden en que se escriben (al mover, el que no pisa a la siguiente). */
  changes: SeriesAppointmentChange[];
  /** Mover: candado de las agendas de estos profesionales y de la sede. */
  lock: { providerIds: string[]; locationId: string } | null;
  /**
   * Cancelar: si tras el cambio no queda ninguna cita pendiente (agendada o
   * confirmada) en la serie, se marca cancelada con este usuario.
   */
  markCancelledBy: string | null;
  /** El ÚNICO `audit_event` de la operación, en la misma transacción. */
  auditEvent: (appointments: Appointment[]) => AuditEventDraft;
}

/**
 * DX-562: lo que decide a quién va el aviso de la serie y con qué textos (la
 * misma regla que los recordatorios: DX-128 y DX-203).
 */
export interface SeriesNoticeContext {
  clinicName: string;
  locationName: string;
  locationTimeZone: string;
  /** Formato y reloj de la sede (crudos); sin ellos no sale el aviso. */
  locationLocale: string | null;
  locationHourCycle: string | null;
  providerName: string | null;
  preferredLanguage: string | null;
  contact: ReminderContact;
  recipient: NoticePatientFields;
  responsibles: NoticeResponsible[];
  majorityReview: MajorityReviewRecord | null;
  majorityAge: number;
}

export interface AppointmentSeriesRepository {
  /** La serie y sus citas vivas (RLS: otra clínica = null). */
  findById(id: string): Promise<AppointmentSeriesSnapshot | null>;
  /**
   * Crea la serie y sus citas en UNA transacción: candado de las series de la
   * clínica y de la agenda, bloqueo duro y EXCLUDE de cada cita, el prospecto
   * (DX-556) una vez, el `audit_event` y el aviso. Una cita que no se puede
   * escribir: `SeriesSlotWriteError` y no queda nada. Reintenta una vez un
   * interbloqueo (40P01).
   */
  create(
    input: CreateSeriesRepoInput,
  ): Promise<{ seriesId: string; appointments: Appointment[] }>;
  /**
   * Cancela o mueve citas de la serie en UNA transacción (`updateInTx` por
   * cita) con su único `audit_event`. Una que no se puede escribir:
   * `SeriesSlotWriteError` y no cambia nada. Reintenta una vez un 40P01.
   */
  applyChanges(input: ApplySeriesChangesInput): Promise<Appointment[]>;
  /** Para el aviso de la serie (paciente, responsables, sede, clínica). */
  noticeContext(input: {
    patientId: string;
    locationId: string;
    providerId: string;
  }): Promise<SeriesNoticeContext | null>;
}
