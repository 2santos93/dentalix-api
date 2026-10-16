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

  update(id: string, patch: UpdateAppointmentRepoInput): Promise<Appointment>;
}
