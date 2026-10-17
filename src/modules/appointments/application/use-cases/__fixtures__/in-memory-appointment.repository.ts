import { ConflictException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { WAITLIST_NOT_OPEN_MESSAGE } from '../../../../waitlist/domain/waitlist-rules';
import { Appointment } from '../../../domain/entities/appointment.entity';
import { WANTS_EARLIER_GONE_MESSAGE } from '../../../domain/wants-earlier';
import type { InMemoryWaitlistRepository } from '../../../../waitlist/application/__fixtures__/in-memory-waitlist';
import {
  AppointmentRepository,
  AppointmentUpdate,
  CreateAppointmentRepoInput,
  ListAppointmentsByRangeParams,
  ListUpcomingAppointmentsParams,
  UpdateAppointmentRepoInput,
} from '../../../domain/ports/appointment-repository.port';

// `Appointment` (the API-facing entity) deliberately has no `deletedAt` field
// — same convention as Patient/ToothRecord, see appointment.entity.ts. The
// fake still has to honour "non-deleted only" like the real Prisma repo, so
// it tracks `deletedAt` on the stored row and strips it via `toEntity`
// (mirrors `mapToEntity` in prisma-appointment.repository.ts).
type StoredAppointment = Appointment & { deletedAt: Date | null };

let seq = 0;

/**
 * Real in-memory fake for `AppointmentRepository` — implements ACTUAL
 * filtering logic (not a canned stub returning a fixed array), so use-case
 * specs built on it genuinely exercise the double-booking business rule.
 * Mirrors `PrismaAppointmentRepository`'s semantics exactly:
 *
 * - `findOverlapping`: same `providerId`, `deletedAt == null`,
 *   `status !== CANCELLED`, half-open interval intersection
 *   (`existing.start < end && existing.end > start` — adjacent appointments
 *   where one's `end` equals the other's `start` do NOT overlap), optionally
 *   excluding `excludeId` (self-exclusion on reschedule).
 * - `listByRange`: `start >= from && start < to`, optional `providerId`,
 *   `providerIds` and `locationId`, ASC by `start`.
 * - `create` appends a SCHEDULED row; `findById` returns a non-deleted row by
 *   id; `update` merges only the defined keys of the patch (an explicit
 *   `null` clears a field, `undefined` leaves it untouched).
 */
export class InMemoryAppointmentRepository implements AppointmentRepository {
  private readonly rows: StoredAppointment[] = [];

  /**
   * DX-122: con unos pendientes en memoria, `update` con `enqueueWaitlist` y
   * `create` con `waitlistEntryId` hacen lo mismo que el repositorio de Prisma
   * dentro de su transacción.
   */
  constructor(private readonly waitlist?: InMemoryWaitlistRepository) {}

  /** Test helper: seed a row directly, bypassing use-case validation. */
  seed(overrides: Partial<StoredAppointment> = {}): Appointment {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row: StoredAppointment = {
      id: overrides.id ?? `seed-${++seq}`,
      tenantId: overrides.tenantId ?? 't1',
      locationId: overrides.locationId ?? 'loc1',
      patientId: overrides.patientId ?? 'p1',
      patientFirstName: overrides.patientFirstName ?? null,
      patientLastName: overrides.patientLastName ?? null,
      providerId: overrides.providerId ?? 'prov1',
      start: overrides.start ?? new Date('2026-08-01T10:00:00.000Z'),
      end: overrides.end ?? new Date('2026-08-01T11:00:00.000Z'),
      status: overrides.status ?? AppointmentStatus.SCHEDULED,
      reason: overrides.reason ?? null,
      notes: overrides.notes ?? null,
      createdById: overrides.createdById ?? null,
      appointmentTypeId: overrides.appointmentTypeId ?? null,
      appointmentType: overrides.appointmentType ?? null,
      confirmationSentAt: overrides.confirmationSentAt ?? null,
      callbackRequestedAt: overrides.callbackRequestedAt ?? null,
      wantsEarlier: overrides.wantsEarlier ?? false,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
      deletedAt: overrides.deletedAt ?? null,
    };
    this.rows.push(row);
    return this.toEntity(row);
  }

  // Explicit field-by-field mapping (mirrors `mapToEntity` in
  // prisma-appointment.repository.ts) rather than destructuring off
  // `deletedAt`, so it stays lint-clean and obviously in sync with the
  // `Appointment` entity shape.
  private toEntity(row: StoredAppointment): Appointment {
    return {
      id: row.id,
      tenantId: row.tenantId,
      locationId: row.locationId,
      patientId: row.patientId,
      patientFirstName: row.patientFirstName,
      patientLastName: row.patientLastName,
      providerId: row.providerId,
      start: row.start,
      end: row.end,
      status: row.status,
      reason: row.reason,
      notes: row.notes,
      createdById: row.createdById,
      appointmentTypeId: row.appointmentTypeId,
      appointmentType: row.appointmentType,
      confirmationSentAt: row.confirmationSentAt,
      callbackRequestedAt: row.callbackRequestedAt,
      wantsEarlier: row.wantsEarlier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  create(input: CreateAppointmentRepoInput): Promise<Appointment> {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const id = `a-${++seq}`;
    if (
      input.waitlistEntryId !== undefined &&
      !this.waitlist?.markScheduled(
        input.waitlistEntryId,
        id,
        input.createdById ?? null,
      )
    ) {
      return Promise.reject(new ConflictException(WAITLIST_NOT_OPEN_MESSAGE));
    }
    const row: StoredAppointment = {
      id,
      tenantId: 't1',
      locationId: input.locationId ?? 'loc1',
      patientId: input.patientId,
      patientFirstName: null,
      patientLastName: null,
      providerId: input.providerId,
      start: input.start,
      end: input.end,
      status: AppointmentStatus.SCHEDULED,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      appointmentTypeId: input.appointmentTypeId ?? null,
      appointmentType: null,
      confirmationSentAt: null,
      callbackRequestedAt: null,
      wantsEarlier: input.wantsEarlier ?? false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve(this.toEntity(row));
  }

  findById(id: string): Promise<Appointment | null> {
    const row = this.rows.find((r) => r.id === id && r.deletedAt === null);
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  listByRange(params: ListAppointmentsByRangeParams): Promise<Appointment[]> {
    const items = this.rows
      .filter((r) => r.deletedAt === null)
      .filter((r) => r.start >= params.from && r.start < params.to)
      .filter((r) => !params.providerId || r.providerId === params.providerId)
      .filter(
        (r) => !params.providerIds || params.providerIds.includes(r.providerId),
      )
      .filter((r) => !params.locationId || r.locationId === params.locationId)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((r) => this.toEntity(r));
    return Promise.resolve(items);
  }

  listUpcoming(params: ListUpcomingAppointmentsParams): Promise<Appointment[]> {
    return this.listByRange({ from: params.from, to: params.to }).then(
      (items) => items.slice(0, params.limit),
    );
  }

  findOverlapping(
    providerId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]> {
    const items = this.rows
      .filter((r) => r.providerId === providerId)
      .filter((r) => r.deletedAt === null)
      .filter((r) => r.status !== AppointmentStatus.CANCELLED)
      // Half-open interval overlap — see PrismaAppointmentRepository for the
      // identical rationale: adjacent appointments (end === start) do NOT
      // satisfy both conditions, so they don't overlap.
      .filter((r) => r.start < end && r.end > start)
      .filter((r) => (excludeId ? r.id !== excludeId : true))
      .map((r) => this.toEntity(r));
    return Promise.resolve(items);
  }

  findOverlappingForPatient(
    patientId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]> {
    // Igual que `findOverlapping` pero por paciente (mismo solape medio-abierto).
    const items = this.rows
      .filter((r) => r.patientId === patientId)
      .filter((r) => r.deletedAt === null)
      .filter((r) => r.status !== AppointmentStatus.CANCELLED)
      .filter((r) => r.start < end && r.end > start)
      .filter((r) => (excludeId ? r.id !== excludeId : true))
      .map((r) => this.toEntity(r));
    return Promise.resolve(items);
  }

  update(
    id: string,
    patch: UpdateAppointmentRepoInput,
  ): Promise<AppointmentUpdate> {
    const row = this.rows.find((r) => r.id === id && r.deletedAt === null);
    if (!row) {
      return Promise.reject(
        new Error(`InMemoryAppointmentRepository.update: not found ${id}`),
      );
    }
    if (
      patch.requireWantsEarlier &&
      !(
        row.wantsEarlier &&
        (row.status === AppointmentStatus.SCHEDULED ||
          row.status === AppointmentStatus.CONFIRMED)
      )
    ) {
      return Promise.reject(new ConflictException(WANTS_EARLIER_GONE_MESSAGE));
    }
    // `revokeConfirmations` es una orden al repo (revocar enlaces), no un campo.
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(
        ([key, value]) =>
          value !== undefined &&
          key !== 'revokeConfirmations' &&
          key !== 'enqueueWaitlist' &&
          key !== 'resolveWaitlist' &&
          key !== 'requireWantsEarlier',
      ),
    );
    Object.assign(row, definedPatch, {
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const enqueued =
      patch.enqueueWaitlist && this.waitlist
        ? this.waitlist.enqueueFromAppointment(
            row,
            patch.enqueueWaitlist.createdById,
          )
        : null;
    const resolvedWaitlistEntryId =
      patch.resolveWaitlist && this.waitlist
        ? this.waitlist.resolveReactivated(
            row.id,
            patch.resolveWaitlist.resolvedById,
          )
        : null;
    return Promise.resolve({
      appointment: this.toEntity(row),
      waitlistEntryId: enqueued && !enqueued.reopened ? enqueued.id : null,
      reopenedWaitlistEntryId:
        enqueued && enqueued.reopened ? enqueued.id : null,
      resolvedWaitlistEntryId,
    });
  }
}
