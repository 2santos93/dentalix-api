import { AppointmentStatus } from '@prisma/client';
import { Appointment } from '../../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  CreateAppointmentRepoInput,
  ListAppointmentsByRangeParams,
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
 *   ASC by `start`.
 * - `create` appends a SCHEDULED row; `findById` returns a non-deleted row by
 *   id; `update` merges only the defined keys of the patch (an explicit
 *   `null` clears a field, `undefined` leaves it untouched).
 */
export class InMemoryAppointmentRepository implements AppointmentRepository {
  private readonly rows: StoredAppointment[] = [];

  /** Test helper: seed a row directly, bypassing use-case validation. */
  seed(overrides: Partial<StoredAppointment> = {}): Appointment {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row: StoredAppointment = {
      id: overrides.id ?? `seed-${++seq}`,
      tenantId: overrides.tenantId ?? 't1',
      patientId: overrides.patientId ?? 'p1',
      providerId: overrides.providerId ?? 'prov1',
      start: overrides.start ?? new Date('2026-08-01T10:00:00.000Z'),
      end: overrides.end ?? new Date('2026-08-01T11:00:00.000Z'),
      status: overrides.status ?? AppointmentStatus.SCHEDULED,
      reason: overrides.reason ?? null,
      notes: overrides.notes ?? null,
      createdById: overrides.createdById ?? null,
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
      patientId: row.patientId,
      providerId: row.providerId,
      start: row.start,
      end: row.end,
      status: row.status,
      reason: row.reason,
      notes: row.notes,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  create(input: CreateAppointmentRepoInput): Promise<Appointment> {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row: StoredAppointment = {
      id: `a-${++seq}`,
      tenantId: 't1',
      patientId: input.patientId,
      providerId: input.providerId,
      start: input.start,
      end: input.end,
      status: AppointmentStatus.SCHEDULED,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
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
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((r) => this.toEntity(r));
    return Promise.resolve(items);
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

  update(id: string, patch: UpdateAppointmentRepoInput): Promise<Appointment> {
    const row = this.rows.find((r) => r.id === id && r.deletedAt === null);
    if (!row) {
      return Promise.reject(
        new Error(`InMemoryAppointmentRepository.update: not found ${id}`),
      );
    }
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    Object.assign(row, definedPatch, {
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    return Promise.resolve(this.toEntity(row));
  }
}
