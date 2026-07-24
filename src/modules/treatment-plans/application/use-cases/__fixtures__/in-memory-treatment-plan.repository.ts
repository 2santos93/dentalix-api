import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../../domain/entities/treatment-plan-item.entity';
import {
  AddTreatmentPlanItemRepoInput,
  CreateTreatmentPlanRepoInput,
  TreatmentPlanRepository,
  UpdateTreatmentPlanItemRepoInput,
  UpdateTreatmentPlanRepoInput,
} from '../../../domain/ports/treatment-plan-repository.port';

// `TreatmentPlan`/`TreatmentPlanItem` (the API-facing entities) deliberately
// have no `deletedAt` field — same convention as Appointment. The fake still
// has to honour "non-deleted only" like the real Prisma repo, so it tracks
// `deletedAt` on the stored rows and strips it via `toPlanEntity`/
// `toItemEntity` (mirrors `mapToEntity` in prisma-treatment-plan.repository.ts).
type StoredPlan = TreatmentPlan & { deletedAt: Date | null };
type StoredItem = TreatmentPlanItem & { deletedAt: Date | null };

let seq = 0;
const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Real in-memory fake for `TreatmentPlanRepository` — implements ACTUAL
 * filtering logic (not a canned stub returning a fixed array), so use-case
 * specs built on it genuinely exercise `deletedAt:null` filtering, item
 * scoping by `planId`, and DESC ordering. Mirrors
 * `PrismaTreatmentPlanRepository`'s semantics exactly.
 */
export class InMemoryTreatmentPlanRepository implements TreatmentPlanRepository {
  private readonly plans: StoredPlan[] = [];
  private readonly items: StoredItem[] = [];

  /** Test helper: seed a plan row directly, bypassing use-case validation. */
  seedPlan(overrides: Partial<StoredPlan> = {}): TreatmentPlan {
    const row: StoredPlan = {
      id: overrides.id ?? `plan-seed-${++seq}`,
      tenantId: overrides.tenantId ?? 't1',
      patientId: overrides.patientId ?? 'p1',
      status: overrides.status ?? TreatmentPlanStatus.DRAFT,
      currency: overrides.currency ?? 'USD',
      notes: overrides.notes ?? null,
      createdById: overrides.createdById ?? null,
      createdAt: overrides.createdAt ?? NOW,
      updatedAt: overrides.updatedAt ?? NOW,
      deletedAt: overrides.deletedAt ?? null,
    };
    this.plans.push(row);
    return this.toPlanEntity(row);
  }

  /** Test helper: seed an item row directly, bypassing use-case validation. */
  seedItem(overrides: Partial<StoredItem> = {}): TreatmentPlanItem {
    const row: StoredItem = {
      id: overrides.id ?? `item-seed-${++seq}`,
      tenantId: overrides.tenantId ?? 't1',
      planId: overrides.planId ?? 'plan-seed-1',
      toothNumber: overrides.toothNumber ?? '11',
      surfaces: overrides.surfaces ?? [],
      catalogItemId: overrides.catalogItemId ?? 'catalog-1',
      price: overrides.price ?? 100,
      status: overrides.status ?? TreatmentPlanItemStatus.PROPOSED,
      notes: overrides.notes ?? null,
      createdAt: overrides.createdAt ?? NOW,
      updatedAt: overrides.updatedAt ?? NOW,
      deletedAt: overrides.deletedAt ?? null,
    };
    this.items.push(row);
    return this.toItemEntity(row);
  }

  // Explicit field-by-field mapping (mirrors `mapToEntity` in the Prisma
  // repo) rather than destructuring off `deletedAt`, so it stays obviously
  // in sync with the entity shape.
  private toPlanEntity(row: StoredPlan): TreatmentPlan {
    return {
      id: row.id,
      tenantId: row.tenantId,
      patientId: row.patientId,
      status: row.status,
      currency: row.currency,
      notes: row.notes,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toItemEntity(row: StoredItem): TreatmentPlanItem {
    return {
      id: row.id,
      tenantId: row.tenantId,
      planId: row.planId,
      toothNumber: row.toothNumber,
      surfaces: row.surfaces,
      catalogItemId: row.catalogItemId,
      price: row.price,
      status: row.status,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  createPlan(input: CreateTreatmentPlanRepoInput): Promise<TreatmentPlan> {
    const row: StoredPlan = {
      id: `plan-${++seq}`,
      tenantId: 't1',
      patientId: input.patientId,
      status: TreatmentPlanStatus.DRAFT,
      currency: 'USD',
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    this.plans.push(row);
    return Promise.resolve(this.toPlanEntity(row));
  }

  findPlanById(id: string): Promise<TreatmentPlanWithItems | null> {
    const row = this.plans.find((p) => p.id === id && p.deletedAt === null);
    if (!row) {
      return Promise.resolve(null);
    }
    const items = this.items
      .filter((i) => i.planId === id && i.deletedAt === null)
      .map((i) => this.toItemEntity(i));
    return Promise.resolve({ ...this.toPlanEntity(row), items });
  }

  listPlansByPatient(patientId: string): Promise<TreatmentPlan[]> {
    const rows = this.plans
      .filter((p) => p.patientId === patientId && p.deletedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => this.toPlanEntity(p));
    return Promise.resolve(rows);
  }

  updatePlan(
    id: string,
    patch: UpdateTreatmentPlanRepoInput,
  ): Promise<TreatmentPlan> {
    const row = this.plans.find((p) => p.id === id && p.deletedAt === null);
    if (!row) {
      return Promise.reject(
        new Error(
          `InMemoryTreatmentPlanRepository.updatePlan: not found ${id}`,
        ),
      );
    }
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    Object.assign(row, definedPatch, { updatedAt: NOW });
    return Promise.resolve(this.toPlanEntity(row));
  }

  addItem(input: AddTreatmentPlanItemRepoInput): Promise<TreatmentPlanItem> {
    const row: StoredItem = {
      id: `item-${++seq}`,
      tenantId: 't1',
      planId: input.planId,
      toothNumber: input.toothNumber,
      surfaces: input.surfaces ?? [],
      catalogItemId: input.catalogItemId,
      price: input.price,
      status: TreatmentPlanItemStatus.PROPOSED,
      notes: input.notes ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    this.items.push(row);
    return Promise.resolve(this.toItemEntity(row));
  }

  findItemById(id: string): Promise<TreatmentPlanItem | null> {
    const row = this.items.find((i) => i.id === id && i.deletedAt === null);
    return Promise.resolve(row ? this.toItemEntity(row) : null);
  }

  updateItem(
    id: string,
    patch: UpdateTreatmentPlanItemRepoInput,
  ): Promise<TreatmentPlanItem> {
    const row = this.items.find((i) => i.id === id && i.deletedAt === null);
    if (!row) {
      return Promise.reject(
        new Error(
          `InMemoryTreatmentPlanRepository.updateItem: not found ${id}`,
        ),
      );
    }
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    Object.assign(row, definedPatch, { updatedAt: NOW });
    return Promise.resolve(this.toItemEntity(row));
  }

  softDeleteItem(id: string): Promise<void> {
    const row = this.items.find((i) => i.id === id && i.deletedAt === null);
    if (!row) {
      return Promise.reject(
        new Error(
          `InMemoryTreatmentPlanRepository.softDeleteItem: not found ${id}`,
        ),
      );
    }
    row.deletedAt = NOW;
    return Promise.resolve();
  }
}
