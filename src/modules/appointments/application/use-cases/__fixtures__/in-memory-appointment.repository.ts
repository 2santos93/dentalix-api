import { ConflictException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { WAITLIST_NOT_OPEN_MESSAGE } from '../../../../waitlist/domain/waitlist-rules';
import {
  Appointment,
  PlanItemReservedElsewhere,
} from '../../../domain/entities/appointment.entity';
import type { ChairSummary } from '../../../../chairs/domain/entities/chair.entity';
import type { AuditRequestContext } from '../../../../audit/domain/audit-request-context';
import { WANTS_EARLIER_GONE_MESSAGE } from '../../../domain/wants-earlier';
import {
  heldInClinicToday,
  PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE,
} from '../../../domain/plan-item-reservation';
import {
  PATIENT_FLOW_MESSAGES,
  isInClinic,
} from '../../../domain/patient-flow';
import {
  computeCancellationNotice,
  type CurrentPolicyRef,
} from '../../../../cancellation-policies/domain/cancellation-policy';
import type { InMemoryWaitlistRepository } from '../../../../waitlist/application/__fixtures__/in-memory-waitlist';
import {
  AppointmentRepository,
  AppointmentUpdate,
  CreateAppointmentRepoInput,
  InClinicAppointment,
  ListInClinicParams,
  PlanItemClaim,
  ListAppointmentsByRangeParams,
  ListUpcomingAppointmentsParams,
  UpdateAppointmentRepoInput,
} from '../../../domain/ports/appointment-repository.port';

/** Zona de la sede del fake: dato de test, no un valor por defecto del producto. */
const FAKE_LOCATION_TIME_ZONE = 'America/Bogota';

// `Appointment` (the API-facing entity) deliberately has no `deletedAt` field
// — same convention as Patient/ToothRecord, see appointment.entity.ts. The
// fake still has to honour "non-deleted only" like the real Prisma repo, so
// it tracks `deletedAt` on the stored row and strips it via `toEntity`
// (mirrors `mapToEntity` in prisma-appointment.repository.ts).
type StoredAppointment = Omit<Appointment, 'chair'> & {
  deletedAt: Date | null;
  /** DX-200: a qué vuelve «Deshacer llegada» (no sale en la entidad). */
  preArrivalStatus: AppointmentStatus | null;
};

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
   * DX-211: sillones que el doble embebe en la cita (lo que en Prisma es el
   * `include` del sillón). Un `chairId` sin entrada sale con `chair: null`.
   */
  readonly chairDirectory = new Map<string, ChairSummary>();

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
      arrivedAt: overrides.arrivedAt ?? null,
      seatedAt: overrides.seatedAt ?? null,
      readyForCheckoutAt: overrides.readyForCheckoutAt ?? null,
      cancelledAt: overrides.cancelledAt ?? null,
      cancelledByKind: overrides.cancelledByKind ?? null,
      cancelReasonCode: overrides.cancelReasonCode ?? null,
      cancelReasonText: overrides.cancelReasonText ?? null,
      noticeMinutes: overrides.noticeMinutes ?? null,
      lateCancellation: overrides.lateCancellation ?? null,
      noShowMarkedAt: overrides.noShowMarkedAt ?? null,
      policyVersionId: overrides.policyVersionId ?? null,
      triageFlags: overrides.triageFlags ?? [],
      triageNote: overrides.triageNote ?? null,
      walkIn: overrides.walkIn ?? false,
      overbooked: overrides.overbooked ?? false,
      chairId: overrides.chairId ?? null,
      preArrivalStatus: overrides.preArrivalStatus ?? null,
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
      arrivedAt: row.arrivedAt,
      seatedAt: row.seatedAt,
      readyForCheckoutAt: row.readyForCheckoutAt,
      cancelledAt: row.cancelledAt,
      cancelledByKind: row.cancelledByKind,
      cancelReasonCode: row.cancelReasonCode,
      cancelReasonText: row.cancelReasonText,
      noticeMinutes: row.noticeMinutes,
      lateCancellation: row.lateCancellation,
      noShowMarkedAt: row.noShowMarkedAt,
      policyVersionId: row.policyVersionId,
      triageFlags: row.triageFlags,
      triageNote: row.triageNote,
      walkIn: row.walkIn,
      overbooked: row.overbooked,
      chairId: row.chairId,
      chair:
        row.chairId !== null
          ? (this.chairDirectory.get(row.chairId) ?? null)
          : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** La sede por defecto del doble (la misma que usa `create`). */
  resolveWriteLocationId(): Promise<string> {
    return Promise.resolve('loc1');
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
      arrivedAt: null,
      seatedAt: null,
      readyForCheckoutAt: null,
      cancelledAt: null,
      cancelledByKind: null,
      cancelReasonCode: null,
      cancelReasonText: null,
      noticeMinutes: null,
      lateCancellation: null,
      noShowMarkedAt: null,
      policyVersionId: null,
      triageFlags: [],
      triageNote: null,
      walkIn: false,
      overbooked: false,
      chairId: input.chairId ?? null,
      preArrivalStatus: null,
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
      .filter(
        (r) =>
          !params.chairIds ||
          (r.chairId !== null && params.chairIds.includes(r.chairId)),
      )
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
      // DX-470: un sobrecupo no ocupa el hueco del profesional.
      .filter((r) => !r.overbooked)
      // Half-open interval overlap — see PrismaAppointmentRepository for the
      // identical rationale: adjacent appointments (end === start) do NOT
      // satisfy both conditions, so they don't overlap.
      .filter((r) => r.start < end && r.end > start)
      .filter((r) => (excludeId ? r.id !== excludeId : true))
      .map((r) => this.toEntity(r));
    return Promise.resolve(items);
  }

  findOverlappingForChair(
    chairId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]> {
    // DX-211: por sillón (mismo solape medio-abierto); un sobrecupo también lo ocupa.
    const items = this.rows
      .filter((r) => r.chairId === chairId)
      .filter((r) => r.deletedAt === null)
      .filter((r) => r.status !== AppointmentStatus.CANCELLED)
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
    if (patch.expectStatus !== undefined && row.status !== patch.expectStatus) {
      return Promise.reject(new ConflictException(PATIENT_FLOW_MESSAGES.stale));
    }
    // `revokeConfirmations` es una orden al repo (revocar enlaces), no un campo.
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(
        ([key, value]) =>
          value !== undefined &&
          key !== 'revokeConfirmations' &&
          key !== 'enqueueWaitlist' &&
          key !== 'resolveWaitlist' &&
          key !== 'requireWantsEarlier' &&
          key !== 'expectStatus' &&
          key !== 'completedExit' &&
          key !== 'audit' &&
          key !== 'cancel' &&
          key !== 'clearCancellation',
      ),
    );
    Object.assign(row, definedPatch, {
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // DX-279: mismo cálculo que el repositorio de Prisma, contra la política
    // de la sede de la cita en el doble (`policies`).
    if (patch.clearCancellation) {
      Object.assign(row, {
        cancelledAt: null,
        cancelledByKind: null,
        cancelReasonCode: null,
        cancelReasonText: null,
        noticeMinutes: null,
        lateCancellation: null,
      });
    }
    if (patch.cancel) {
      const policy = this.policies.get(row.locationId) ?? null;
      Object.assign(row, {
        cancelledAt: patch.cancel.at,
        cancelledByKind: patch.cancel.byKind,
        cancelReasonCode: patch.cancel.reasonCode,
        cancelReasonText: patch.cancel.reasonText,
        ...computeCancellationNotice({
          start: row.start,
          cancelledAt: patch.cancel.at,
          byKind: patch.cancel.byKind,
          noticeHours: policy?.noticeHours ?? null,
          attended: patch.cancel.attended,
        }),
      });
    }
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
    if (patch.completedExit) this.completedExits.push(patch.completedExit);
    return Promise.resolve({
      appointment: this.toEntity(row),
      ...(patch.completedExit
        ? {
            completedExit: {
              reversalId: `reversal-${this.completedExits.length}`,
              reason: patch.completedExit.reason,
              visitMinimums: [],
            },
          }
        : {}),
      waitlistEntryId: enqueued && !enqueued.reopened ? enqueued.id : null,
      reopenedWaitlistEntryId:
        enqueued && enqueued.reopened ? enqueued.id : null,
      resolvedWaitlistEntryId,
    });
  }

  undoArrival(
    id: string,
    options: { clearOverbooked?: boolean } = {},
  ): Promise<Appointment | null> {
    const row = this.rows.find((r) => r.id === id && r.deletedAt === null);
    if (
      !row ||
      row.status !== AppointmentStatus.ARRIVED ||
      row.preArrivalStatus === null
    ) {
      return Promise.resolve(null);
    }
    Object.assign(row, {
      status: row.preArrivalStatus,
      preArrivalStatus: null,
      arrivedAt: null,
      ...(options.clearOverbooked ? { overbooked: false } : {}),
    });
    return Promise.resolve(this.toEntity(row));
  }

  /** DX-279: política vigente de cada sede (test helper). */
  readonly policies = new Map<string, CurrentPolicyRef>();

  currentCancellationPolicy(
    locationId: string,
  ): Promise<CurrentPolicyRef | null> {
    return Promise.resolve(this.policies.get(locationId) ?? null);
  }

  /** Test helper: nombres de los profesionales que devuelve `listInClinic`. */
  readonly providerNames = new Map<string, string>();
  /** Test helper (DX-470): tipos de cita de urgencia. */
  readonly urgentTypeIds = new Set<string>();

  listInClinic(params: ListInClinicParams): Promise<InClinicAppointment[]> {
    const items = this.rows
      .filter((r) => r.deletedAt === null && isInClinic(r.status))
      .filter((r) => r.locationId === params.locationId)
      .filter((r) => r.start >= params.from && r.start < params.to)
      .filter((r) => !params.providerId || r.providerId === params.providerId)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((r) => ({
        ...this.toEntity(r),
        providerName: this.providerNames.get(r.providerId) ?? null,
        urgent:
          r.appointmentTypeId !== null &&
          this.urgentTypeIds.has(r.appointmentTypeId),
      }));
    return Promise.resolve(items);
  }

  /** DX-273: lo que el repositorio recibió para sacar citas de COMPLETED. */
  readonly completedExits: NonNullable<
    UpdateAppointmentRepoInput['completedExit']
  >[] = [];

  /** DX-273: tratamientos reservados en otra cita, por cita (test helper). */
  readonly reservedElsewhere = new Map<string, PlanItemReservedElsewhere[]>();

  /** DX-273: las llamadas a «Traer a esta cita». */
  readonly claims: {
    appointmentId: string;
    planItemId: string;
    audit: AuditRequestContext;
  }[] = [];

  findPlanItemsReservedElsewhere(
    appointmentIds: readonly string[],
  ): Promise<Map<string, PlanItemReservedElsewhere[]>> {
    return Promise.resolve(
      new Map(
        appointmentIds.flatMap((id) => {
          const items = this.reservedElsewhere.get(id) ?? [];
          return items.length ? [[id, items] as const] : [];
        }),
      ),
    );
  }

  claimPlanItem(
    appointmentId: string,
    planItemId: string,
    audit: AuditRequestContext,
  ): Promise<PlanItemClaim> {
    const row = this.rows.find(
      (r) => r.id === appointmentId && r.deletedAt === null,
    );
    if (!row) return Promise.reject(new Error('not found'));
    const items = this.reservedElsewhere.get(appointmentId) ?? [];
    const moved = items.find((i) => i.planItemId === planItemId);
    // DX-288: como el repositorio real, no se trae desde una cita de hoy
    // con el paciente en la clínica (zona fija de test: el fake no tiene
    // sedes con zona).
    const holder = moved && this.rows.find((r) => r.id === moved.appointmentId);
    if (
      holder &&
      heldInClinicToday(holder, FAKE_LOCATION_TIME_ZONE, new Date())
    )
      return Promise.reject(
        new ConflictException(PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE),
      );
    this.claims.push({ appointmentId, planItemId, audit });
    this.reservedElsewhere.set(
      appointmentId,
      items.filter((i) => i.planItemId !== planItemId),
    );
    // Las demás citas con el ítem ven ahora la reserva en esta.
    for (const [id, list] of this.reservedElsewhere)
      if (id !== appointmentId)
        this.reservedElsewhere.set(
          id,
          list.map((i) =>
            i.planItemId === planItemId ? { ...i, appointmentId } : i,
          ),
        );
    return Promise.resolve({
      appointment: this.toEntity(row),
      fromAppointmentId: moved?.appointmentId ?? null,
    });
  }
}
