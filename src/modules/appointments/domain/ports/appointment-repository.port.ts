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
}

export interface UpdateAppointmentRepoInput {
  start?: Date;
  end?: Date;
  status?: AppointmentStatus;
  reason?: string | null;
  notes?: string | null;
}

export interface ListAppointmentsByRangeParams {
  from: Date;
  to: Date;
  providerId?: string;
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

  update(id: string, patch: UpdateAppointmentRepoInput): Promise<Appointment>;
}
