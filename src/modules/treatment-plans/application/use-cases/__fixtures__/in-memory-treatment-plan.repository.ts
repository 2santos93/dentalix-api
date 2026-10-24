import {
  TreatmentPlanItemStatus,
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  TreatmentPlan,
  TreatmentPlanAcceptanceSummary,
  TreatmentPlanWithItems,
} from '../../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../../domain/entities/treatment-plan-item.entity';
import {
  CreateTreatmentPlanRepoInput,
  DecideBulkDiscount,
  DecideItemChange,
  DecideNewItem,
  DiscountStamp,
  DecidePlanChange,
  DoneMirrorInput,
  PaymentPlanCancellation,
  TreatmentPlanRepository,
} from '../../../domain/ports/treatment-plan-repository.port';
import {
  AlternativeSource,
  NewAlternative,
  PendingFollowUpQuery,
  PendingFollowUpRow,
  PlanOptionsRepository,
} from '../../../domain/ports/plan-options-repository.port';
import {
  PAYMENT_PLAN_CANCELLED_BY_OTHER_OPTION_REASON,
  optionSiblingsToReject,
  siblingRejectionBlockedMessage,
} from '../../../domain/plan-options';
import type { ItemAttributionChange } from '../../../domain/plan-item-attribution';

// `TreatmentPlan`/`TreatmentPlanItem` (the API-facing entities) deliberately
// have no `deletedAt` field — same convention as Appointment. The fake still
// has to honour "non-deleted only" like the real Prisma repo, so it tracks
// `deletedAt` on the stored rows and strips it via `toPlanEntity`/
// `toItemEntity` (mirrors `mapToEntity` in prisma-treatment-plan.repository.ts).
type StoredPlan = TreatmentPlan & {
  deletedAt: Date | null;
  acceptance: TreatmentPlanAcceptanceSummary | null;
};
type StoredItem = TreatmentPlanItem & { deletedAt: Date | null };

let seq = 0;

/** DX-050: un ítem sin atribución (fuera de DONE, o «Sin atribuir»). */
const NO_ATTRIBUTION = {
  performedById: null,
  performedByName: null,
  performedLocationId: null,
  performedLocationName: null,
  completedAt: null,
} as const;
const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Real in-memory fake for `TreatmentPlanRepository` — implements ACTUAL
 * filtering logic (not a canned stub returning a fixed array), so use-case
 * specs built on it genuinely exercise `deletedAt:null` filtering, item
 * scoping by `planId`, and DESC ordering. Mirrors
 * `PrismaTreatmentPlanRepository`'s semantics exactly.
 */
export class InMemoryTreatmentPlanRepository
  implements TreatmentPlanRepository, PlanOptionsRepository
{
  private readonly plans: StoredPlan[] = [];
  private readonly items: StoredItem[] = [];
  /** Sede que el repositorio real tomaría del request (o la principal). */
  locationId = 'loc-1';
  /** Filas que devuelve `listPendingFollowUp` (el filtro SQL se prueba en integración). */
  pendingFollowUp: PendingFollowUpRow[] = [];
  lastFollowUpQuery: PendingFollowUpQuery | null = null;
  /** Planes con abonos vivos (los abonos son de otro módulo). */
  readonly livePaymentPlanIds = new Set<string>();
  /** Planes con un plan de cuotas ACTIVO (DX-109). */
  readonly activePaymentPlanIds = new Set<string>();
  /** Cancelaciones de planes de cuotas hechas junto a su plan (DX-109). */
  readonly paymentPlanCancellations: {
    planId: string;
    at: Date;
    byId: string | null;
    reason: string;
  }[] = [];

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
      optionGroupId: overrides.optionGroupId ?? null,
      optionLabel: overrides.optionLabel ?? null,
      presentedAt: overrides.presentedAt ?? null,
      presentedLocationId: overrides.presentedLocationId ?? null,
      rejectedAt: overrides.rejectedAt ?? null,
      rejectionReason: overrides.rejectionReason ?? null,
      rejectionNote: overrides.rejectionNote ?? null,
      createdAt: overrides.createdAt ?? NOW,
      updatedAt: overrides.updatedAt ?? NOW,
      deletedAt: overrides.deletedAt ?? null,
      acceptance: overrides.acceptance ?? null,
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
      catalogPrice: overrides.catalogPrice ?? null,
      basePrice: overrides.basePrice ?? null,
      priceSource: overrides.priceSource ?? null,
      agreementId: overrides.agreementId ?? null,
      agreementName: overrides.agreementName ?? null,
      pricingLocationId: overrides.pricingLocationId ?? null,
      price: overrides.price ?? 100,
      discount: overrides.discount ?? 0,
      discountReason: overrides.discountReason ?? null,
      discountReasonNote: overrides.discountReasonNote ?? null,
      discountById: overrides.discountById ?? null,
      discountAt: overrides.discountAt ?? null,
      discountLocationId: overrides.discountLocationId ?? null,
      status: overrides.status ?? TreatmentPlanItemStatus.PROPOSED,
      performedById: overrides.performedById ?? null,
      performedByName: overrides.performedByName ?? null,
      performedLocationId: overrides.performedLocationId ?? null,
      performedLocationName: overrides.performedLocationName ?? null,
      completedAt: overrides.completedAt ?? null,
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
      optionGroupId: row.optionGroupId,
      optionLabel: row.optionLabel,
      presentedAt: row.presentedAt,
      presentedLocationId: row.presentedLocationId,
      rejectedAt: row.rejectedAt,
      rejectionReason: row.rejectionReason,
      rejectionNote: row.rejectionNote,
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
      catalogPrice: row.catalogPrice,
      basePrice: row.basePrice,
      priceSource: row.priceSource,
      agreementId: row.agreementId,
      agreementName: row.agreementName,
      pricingLocationId: row.pricingLocationId,
      price: row.price,
      discount: row.discount,
      discountReason: row.discountReason,
      discountReasonNote: row.discountReasonNote,
      discountById: row.discountById,
      discountAt: row.discountAt,
      discountLocationId: row.discountLocationId,
      status: row.status,
      performedById: row.performedById,
      performedByName: row.performedByName,
      performedLocationId: row.performedLocationId,
      performedLocationName: row.performedLocationName,
      completedAt: row.completedAt,
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
      currency: input.currency,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      optionGroupId: null,
      optionLabel: null,
      presentedAt: null,
      presentedLocationId: null,
      rejectedAt: null,
      rejectionReason: null,
      rejectionNote: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      acceptance: null,
    };
    this.plans.push(row);
    return Promise.resolve(this.toPlanEntity(row));
  }

  /** Test helper: el plan tal como está guardado (estado, rechazo…). */
  stored(id: string): TreatmentPlan {
    const row = this.plans.find((p) => p.id === id);
    if (!row) throw new Error(`InMemoryTreatmentPlanRepository: no ${id}`);
    return this.toPlanEntity(row);
  }

  private liveSiblings(row: StoredPlan): StoredPlan[] {
    if (!row.optionGroupId) return [];
    return this.plans.filter(
      (p) =>
        p.id !== row.id &&
        p.deletedAt === null &&
        p.optionGroupId === row.optionGroupId,
    );
  }

  findPlanById(id: string): Promise<TreatmentPlanWithItems | null> {
    return Promise.resolve(this.lockedPlan(id));
  }

  /**
   * El plan tal como lo relee el repositorio real dentro de su transacción,
   * con la fila bloqueada (BE-036): no pasa por `findPlanById`, que una spec
   * puede sustituir por una lectura previa ya vieja.
   */
  private lockedPlan(id: string): TreatmentPlanWithItems | null {
    const row = this.plans.find((p) => p.id === id && p.deletedAt === null);
    if (!row) {
      return null;
    }
    const items = this.items
      .filter((i) => i.planId === id && i.deletedAt === null)
      .map((i) => this.toItemEntity(i));
    return {
      ...this.toPlanEntity(row),
      items,
      acceptance: row.acceptance,
    };
  }

  /** Igual que el repositorio real: `decide` que lanza no escribe nada. */
  private decided<T>(decide: () => T): Promise<T> {
    try {
      return Promise.resolve(decide());
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  listPlansByPatient(patientId: string): Promise<TreatmentPlan[]> {
    const rows = this.plans
      .filter((p) => p.patientId === patientId && p.deletedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => this.toPlanEntity(p));
    return Promise.resolve(rows);
  }

  private cancelPaymentPlanOf(
    planId: string,
    cancellation: PaymentPlanCancellation,
  ): void {
    if (!this.activePaymentPlanIds.has(planId)) return;
    // Un Set en memoria, no una tabla: el real deja el plan de cuotas
    // CANCELLED (soft), aquí solo deja de estar activo.
    // eslint-disable-next-line no-restricted-syntax
    this.activePaymentPlanIds.delete(planId);
    this.paymentPlanCancellations.push({ planId, ...cancellation });
  }

  // Mismo contrato que el repositorio real: `decide` ve el plan actual y, si
  // lanza, no se escribe nada; con `acceptedAt` rechaza a las hermanas.
  async updatePlan(
    id: string,
    decide: DecidePlanChange,
  ): Promise<TreatmentPlan> {
    const current = await this.findPlanById(id);
    const row = this.plans.find((p) => p.id === id && p.deletedAt === null);
    if (!current || !row) {
      throw new NotFoundException('Plan de tratamiento no encontrado');
    }
    const change = decide(current, {
      hasLivePayments: this.livePaymentPlanIds.has(id),
      hasActivePaymentPlan: this.activePaymentPlanIds.has(id),
    });
    const siblings = this.liveSiblings(row);
    if (change.acceptedAt) {
      const { reject, conflict } = optionSiblingsToReject(siblings);
      if (conflict) throw new ConflictException('Otra opción ya aceptada');
      const charged = siblings.find(
        (sibling) =>
          reject.includes(sibling.id) &&
          (this.livePaymentPlanIds.has(sibling.id) ||
            this.items.some(
              (i) =>
                i.planId === sibling.id &&
                i.deletedAt === null &&
                i.status === TreatmentPlanItemStatus.DONE,
            )),
      );
      if (charged) {
        throw new ConflictException(
          siblingRejectionBlockedMessage(charged.optionLabel),
        );
      }
      for (const sibling of siblings.filter((s) => reject.includes(s.id))) {
        Object.assign(sibling, {
          status: TreatmentPlanStatus.REJECTED,
          rejectedAt: change.acceptedAt,
          rejectionReason: TreatmentPlanRejectionReason.OTHER_OPTION_ACCEPTED,
          rejectionNote: null,
        });
        this.cancelPaymentPlanOf(sibling.id, {
          at: change.acceptedAt,
          byId: change.acceptedById ?? null,
          reason: PAYMENT_PLAN_CANCELLED_BY_OTHER_OPTION_REASON,
        });
      }
    }
    if (change.acceptedAt) {
      for (const item of this.items) {
        if (
          item.planId === id &&
          item.deletedAt === null &&
          item.status === TreatmentPlanItemStatus.PROPOSED
        ) {
          item.status = TreatmentPlanItemStatus.ACCEPTED;
        }
      }
    }
    if (change.cancellation) {
      this.cancelPaymentPlanOf(id, change.cancellation);
    }
    if (change.status !== undefined) row.status = change.status;
    if (change.currency !== undefined) row.currency = change.currency;
    if (change.notes !== undefined) row.notes = change.notes;
    if (change.optionLabel !== undefined) row.optionLabel = change.optionLabel;
    if (change.presentation) {
      row.presentedAt = change.presentation.at;
      row.presentedLocationId = this.locationId;
    }
    if (change.rejection) {
      row.rejectedAt = change.rejection.at;
      row.rejectionReason = change.rejection.reason;
      row.rejectionNote = change.rejection.note;
    }
    row.updatedAt = NOW;
    return this.toPlanEntity(row);
  }

  async createAlternative(
    sourcePlanId: string,
    decide: (source: AlternativeSource) => NewAlternative,
  ): Promise<TreatmentPlan | null> {
    const plan = await this.findPlanById(sourcePlanId);
    const row = this.plans.find(
      (p) => p.id === sourcePlanId && p.deletedAt === null,
    );
    if (!plan || !row) return null;
    const decision = decide({
      plan,
      siblings: this.liveSiblings(row).map((p) => this.toPlanEntity(p)),
    });
    row.optionGroupId = row.optionGroupId ?? row.id;
    row.optionLabel = decision.sourceLabel;
    const created: StoredPlan = {
      ...row,
      id: `plan-${++seq}`,
      status: TreatmentPlanStatus.DRAFT,
      optionLabel: decision.label,
      createdById: decision.createdById ?? null,
      presentedAt: null,
      presentedLocationId: null,
      rejectedAt: null,
      rejectionReason: null,
      rejectionNote: null,
      acceptance: null,
    };
    this.plans.push(created);
    for (const item of plan.items) {
      this.items.push({
        ...item,
        id: `item-${++seq}`,
        planId: created.id,
        status: TreatmentPlanItemStatus.PROPOSED,
        deletedAt: null,
      });
    }
    return this.toPlanEntity(created);
  }

  listPendingFollowUp(
    query: PendingFollowUpQuery,
  ): Promise<{ rows: PendingFollowUpRow[]; total: number }> {
    this.lastFollowUpQuery = query;
    const start = (query.page - 1) * query.pageSize;
    return Promise.resolve({
      rows: this.pendingFollowUp.slice(start, start + query.pageSize),
      total: this.pendingFollowUp.length,
    });
  }

  async addItem(
    planId: string,
    decide: DecideNewItem,
  ): Promise<TreatmentPlanItem> {
    const plan = this.lockedPlan(planId);
    if (!plan) {
      throw new NotFoundException('Treatment plan not found');
    }
    const input = await this.decided(() => decide(plan));
    const row: StoredItem = {
      id: `item-${++seq}`,
      tenantId: 't1',
      planId,
      toothNumber: input.toothNumber,
      surfaces: input.surfaces ?? [],
      catalogItemId: input.catalogItemId,
      catalogPrice: input.catalogPrice,
      ...input.pricing,
      price: input.price,
      discount: input.discount ?? 0,
      discountReason: input.discountReason ?? null,
      discountReasonNote: input.discountReasonNote ?? null,
      ...this.stampColumns(input.discountStamp ?? null),
      status: TreatmentPlanItemStatus.PROPOSED,
      ...NO_ATTRIBUTION,
      notes: input.notes ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    this.items.push(row);
    return this.toItemEntity(row);
  }

  findItemById(id: string): Promise<TreatmentPlanItem | null> {
    const row = this.items.find((i) => i.id === id && i.deletedAt === null);
    return Promise.resolve(row ? this.toItemEntity(row) : null);
  }

  /** Último espejo DONE → odontograma que pidió `decide` (Pieza B). */
  lastMirror: DoneMirrorInput | undefined;

  async updateItem(
    id: string,
    decide: DecideItemChange,
  ): Promise<TreatmentPlanItem> {
    const row = this.items.find((i) => i.id === id && i.deletedAt === null);
    const plan = row && this.lockedPlan(row.planId);
    if (!row || !plan) {
      throw new NotFoundException('Treatment plan item not found');
    }
    const { patch, mirror, attribution } = await this.decided(() =>
      decide({ plan, item: this.toItemEntity(row) }),
    );
    this.lastMirror = mirror;
    const { discountStamp, ...fields } = patch;
    const definedPatch = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    Object.assign(row, definedPatch, { updatedAt: NOW });
    if (discountStamp !== undefined) {
      Object.assign(row, this.stampColumns(discountStamp));
    }
    if (attribution) Object.assign(row, this.attributionColumns(attribution));
    return this.toItemEntity(row);
  }

  /** DX-050: igual que el repositorio real, sin resolver nombres. */
  private attributionColumns(
    change: ItemAttributionChange,
  ): Partial<StoredItem> {
    if (change.kind === 'CLEAR') return NO_ATTRIBUTION;
    if (change.kind === 'SET') {
      return {
        performedById: change.performedById,
        performedLocationId: this.locationId,
        completedAt: change.completedAt,
      };
    }
    return Object.fromEntries(
      Object.entries({
        performedById: change.performedById,
        completedAt: change.completedAt,
      }).filter(([, value]) => value !== undefined),
    );
  }

  /** Igual que el repositorio real: la sede es la del request (o la principal). */
  private stampColumns(stamp: DiscountStamp | null) {
    return stamp
      ? {
          discountById: stamp.byId,
          discountAt: stamp.at,
          discountLocationId: this.locationId,
        }
      : { discountById: null, discountAt: null, discountLocationId: null };
  }

  async applyBulkDiscount(
    planId: string,
    itemIds: string[],
    decide: DecideBulkDiscount,
  ): Promise<TreatmentPlanItem[]> {
    const ids = [...new Set(itemIds)];
    const plan = this.lockedPlan(planId);
    const rows = this.items.filter(
      (i) => ids.includes(i.id) && i.planId === planId && i.deletedAt === null,
    );
    if (!plan) {
      throw new NotFoundException('Plan de tratamiento no encontrado');
    }
    if (rows.length !== ids.length) {
      throw new NotFoundException(
        'Algún ítem no existe o no es de este plan de tratamiento.',
      );
    }
    const changes = await this.decided(() =>
      decide({ plan, items: rows.map((r) => this.toItemEntity(r)) }),
    );
    return changes.map((change) => {
      const { itemId, discountStamp, ...fields } = change;
      const row = rows.find((r) => r.id === itemId)!;
      const definedFields = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      Object.assign(row, definedFields, { updatedAt: NOW });
      if (discountStamp !== undefined) {
        Object.assign(row, this.stampColumns(discountStamp));
      }
      return this.toItemEntity(row);
    });
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

/** Campos de opción/presentación/rechazo (DX-040) de un plan suelto, para fakes. */
export const PLAN_WITHOUT_OPTIONS = {
  optionGroupId: null,
  optionLabel: null,
  presentedAt: null,
  presentedLocationId: null,
  rejectedAt: null,
  rejectionReason: null,
  rejectionNote: null,
} as const;
