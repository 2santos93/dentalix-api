import type { AppointmentStatus, ClinicRole, Prisma } from '@prisma/client';
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
  /**
   * El aviso al paciente, insertado en la MISMA transacción (DX-463) con el
   * tope de emails comprobado ahí, bajo su candado: si no cabe
   * (`EmailQuotaExceededError`), la serie se crea igual y sin aviso. Si se
   * encola, su registro en `outbound_messages` (id = `referenceId` del
   * email, QUEUED, con la primera cita) va en la misma transacción.
   */
  email: SeriesNoticeWrite | null;
}

export interface SeriesNoticeWrite {
  insert(tx: Prisma.TransactionClient): Promise<{ id: string }>;
  /**
   * DX-128: el enlace de baja que lleva el email (su hash), creado en la
   * misma transacción solo si el email se encola: sin aviso, sin enlace.
   */
  optOut: { patientId: string; tokenHash: string; expiresAt: Date } | null;
  outbound: {
    id: string;
    recipient: string;
    recipientKind: 'PATIENT' | 'RESPONSIBLE';
    language: string;
    languageFallbackFrom: string | null;
  };
}

/** Qué pasó con el aviso dentro de la transacción. */
export type SeriesNoticeOutcome = 'QUEUED' | 'QUOTA' | null;

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

/**
 * DX-562: alguna cita de la serie ya no está como se leyó al planificar (otra
 * persona la canceló, la atendió o la movió entre la vista y la escritura):
 * no se escribió nada.
 */
export class SeriesStaleError extends Error {
  constructor(readonly appointmentIds: string[]) {
    super('Alguna cita de la serie cambió mientras tanto');
    this.name = 'SeriesStaleError';
  }
}

/** DX-562: una cita de la serie que se cancela o se mueve, con su cambio. */
export interface SeriesAppointmentChange {
  id: string;
  /**
   * Cómo se leyó al planificar: con la fila bloqueada se exige igual (estado
   * y hora); si no, `SeriesStaleError`.
   */
  expect: { status: AppointmentStatus; start: Date };
  patch: UpdateAppointmentRepoInput;
}

export interface ApplySeriesChangesInput {
  /** En el orden en que se escriben (al mover, el que no pisa a la siguiente). */
  changes: SeriesAppointmentChange[];
  /** Mover: candado de las agendas de estos profesionales y de la sede. */
  lock: { providerIds: string[]; locationId: string } | null;
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
  create(input: CreateSeriesRepoInput): Promise<{
    seriesId: string;
    appointments: Appointment[];
    notice: SeriesNoticeOutcome;
  }>;
  /**
   * Cancela o mueve citas de la serie en UNA transacción (`updateInTx` por
   * cita) con su único `audit_event`. Orden de candados: el de las series de
   * la clínica, las FILAS de las citas (por id, `FOR UPDATE`) y luego las
   * agendas (como el PATCH suelto: fila → agenda). Una cita que ya no está
   * como se leyó: `SeriesStaleError`; una que no se puede escribir:
   * `SeriesSlotWriteError` (un ítem del plan reservado en otra cita sale ya
   * como su 409). Sin reintento: un 40P01 lo replanifica el caso de uso.
   */
  applyChanges(input: ApplySeriesChangesInput): Promise<Appointment[]>;
  /** Para el aviso de la serie (paciente, responsables, sede, clínica). */
  noticeContext(input: {
    patientId: string;
    locationId: string;
    providerId: string;
  }): Promise<SeriesNoticeContext | null>;
}
