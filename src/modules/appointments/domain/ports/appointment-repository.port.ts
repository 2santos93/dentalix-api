import { AppointmentStatus } from '@prisma/client';
import { Appointment } from '../entities/appointment.entity';

// NOTE: deliberately NO `tenantId`/`id`/`status` field — the tenant comes from
// the guarded request context (never the client, same convention as
// CreatePatientRepoInput / CreateToothRecordRepoInput). `status` always
// starts at the schema default (SCHEDULED) on create; there is no way to
// create an appointment in any other status.
export interface CreateAppointmentRepoInput {
  patientId: string;
  providerId: string;
  start: Date;
  end: Date;
  reason?: string;
  notes?: string;
  createdById?: string;
  /** DX-121: tipo ya validado (de esta clínica y activo) por el use-case. */
  appointmentTypeId?: string;
  /**
   * DX-122: sede de la cita cuando NO es la del request (agendar desde
   * «Pendientes»: la de la entrada). Ya validada por quien la pasa.
   */
  locationId?: string;
  /**
   * DX-122: la entrada de pendientes que esta cita resuelve. En la MISMA
   * transacción pasa a SCHEDULED, solo si sigue OPEN; si no, 409 y no se crea
   * la cita.
   */
  waitlistEntryId?: string;
  /** DX-210: «Adelantar si hay hueco» (por defecto false). */
  wantsEarlier?: boolean;
}

export interface UpdateAppointmentRepoInput {
  start?: Date;
  end?: Date;
  /** DX-121: mover la cita a otro profesional (ya validado por el use-case). */
  providerId?: string;
  status?: AppointmentStatus;
  reason?: string | null;
  notes?: string | null;
  /** Solo para limpiarlos (DX-005): los fija el flujo de confirmación, no el PATCH. */
  confirmationSentAt?: null;
  callbackRequestedAt?: null;
  /**
   * DX-005/DX-121: revoca, en la MISMA transacción, los enlaces de confirmación
   * aún sin responder. Hace falta además de limpiar `confirmationSentAt`: el
   * enlace caduca solo si cambia la hora de inicio o el estado, así que mover la
   * cita a otro profesional a la misma hora lo dejaría vigente.
   */
  revokeConfirmations?: boolean;
  /**
   * DX-122: la cita pasa a CANCELLED o NO_SHOW: en la MISMA transacción se crea
   * su entrada OPEN en «Pendientes por agendar» (una sola por cita, aunque el
   * estado cambie dos veces).
   */
  enqueueWaitlist?: { createdById: string | null };
  /**
   * DX-122 (revisión H1): la cita deja de estar cancelada o no-show (vuelve a
   * agendada, confirmada o completada): su entrada OPEN de «Pendientes» se
   * cierra en la MISMA transacción, resuelta por la propia cita.
   */
  resolveWaitlist?: { resolvedById: string | null };
  /** DX-210: «Adelantar si hay hueco». */
  wantsEarlier?: boolean;
  /**
   * DX-210: mover la cita a un hueco libre SOLO si sigue marcada «Adelantar si
   * hay hueco» y agendada o confirmada. La condición y el cambio van en la
   * misma sentencia (a prueba de carreras): si ya no se cumple, 409.
   */
  requireWantsEarlier?: boolean;
}

/** La cita actualizada y, si se creó, la entrada de pendientes (DX-122). */
export interface AppointmentUpdate {
  appointment: Appointment;
  /** Id de la entrada OPEN creada ahora; `null` si no se creó (o ya existía). */
  waitlistEntryId: string | null;
  /**
   * Id de la entrada que se reabrió: la cita se reactivó (cerrando su entrada)
   * y ahora vuelve a cancelarse o no-show; `null` si no hubo que reabrir.
   */
  reopenedWaitlistEntryId: string | null;
  /** Id de la entrada que se cerró al reactivar la cita; `null` si no había. */
  resolvedWaitlistEntryId: string | null;
}

export interface ListAppointmentsByRangeParams {
  from: Date;
  to: Date;
  providerId?: string;
  /** DX-121: columnas de la vista Día (ids ya validados contra el personal). */
  providerIds?: string[];
  /** DX-121: sede explícita; si falta, la sede del request (X-Location-Id). */
  locationId?: string;
}

export interface ListUpcomingAppointmentsParams {
  from: Date;
  to: Date;
  limit: number;
}

export const APPOINTMENT_REPOSITORY = Symbol('APPOINTMENT_REPOSITORY');

export interface AppointmentRepository {
  create(input: CreateAppointmentRepoInput): Promise<Appointment>;
  findById(id: string): Promise<Appointment | null>;

  /**
   * Non-deleted appointments whose `start` falls within `[from, to)`,
   * optionally narrowed to a single provider, ordered by `start` ASC.
   */
  listByRange(params: ListAppointmentsByRangeParams): Promise<Appointment[]>;

  /**
   * Como `listByRange` sin profesional, pero cortado EN LA BD a las primeras
   * `limit` citas por `start` ASC (DX-043): lo sirven
   * `appointments_tenant_start_live_idx` (consolidado) y
   * `appointments_tenant_location_start_idx` (con sede).
   */
  listUpcoming(params: ListUpcomingAppointmentsParams): Promise<Appointment[]>;

  /**
   * Non-deleted, non-CANCELLED appointments for `providerId` whose
   * `[start, end)` interval overlaps the given `[start, end)` interval
   * (half-open — back-to-back appointments where one's `end` equals the
   * other's `start` do NOT overlap). Pass `excludeId` when re-checking a
   * reschedule so the appointment being updated doesn't collide with
   * itself.
   */
  findOverlapping(
    providerId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]>;

  /**
   * Igual que `findOverlapping` pero por PACIENTE: citas activas y no canceladas
   * del paciente que se solapan con `[start, end)`. Un paciente no puede estar
   * en dos sillones a la vez, así que esto es tan inválido como el solape por
   * profesional. `excludeId` permite excluir la propia cita al reagendar.
   */
  findOverlappingForPatient(
    patientId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]>;

  update(
    id: string,
    patch: UpdateAppointmentRepoInput,
  ): Promise<AppointmentUpdate>;
}
