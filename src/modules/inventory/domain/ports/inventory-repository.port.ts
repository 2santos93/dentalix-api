import { InventoryMovementType } from '@prisma/client';
import { InventoryItem } from '../entities/inventory-item.entity';
import { InventoryMovement } from '../entities/inventory-movement.entity';

// NOTE: deliberately NO `tenantId`/`id` field — the tenant comes from the
// guarded request context (never the client), same convention as
// CreateTreatmentPlanRepoInput/CreateSaleRepoInput. `minStock` is REQUIRED
// here (the use case resolves the "omitted → default 0" fallback BEFORE
// calling the repository), so by the time this input reaches the repo the
// value is always resolved.
export interface CreateInventoryItemRepoInput {
  name: string;
  sku?: string;
  unit: string;
  minStock: number;
  notes?: string;
  createdById?: string;
}

export interface UpdateInventoryItemRepoInput {
  name?: string;
  sku?: string | null;
  unit?: string;
  minStock?: number;
  notes?: string | null;
}

// NOTE: deliberately NO `tenantId`/`id`/`occurredAt` field — tenant from
// context, `occurredAt` always defaults to `now()` at the schema level (v1
// has no "backdated movement" use case).
export interface CreateInventoryMovementRepoInput {
  itemId: string;
  type: InventoryMovementType;
  quantity: number;
  reason?: string;
  createdById?: string;
}

export const INVENTORY_REPOSITORY = Symbol('INVENTORY_REPOSITORY');

export interface InventoryRepository {
  createItem(input: CreateInventoryItemRepoInput): Promise<InventoryItem>;

  /** A single active (non-deleted) item, or `null` if absent/soft-deleted/
   * another tenant (RLS makes those indistinguishable from "absent"). */
  findItemById(id: string): Promise<InventoryItem | null>;

  /** Active items only (`deletedAt: null`), no `stock`/`lowStock` attached —
   * computing those is `ListInventoryItemsUseCase`'s job, using
   * `sumSignedQuantityAll` to avoid an N+1. */
  listItems(): Promise<InventoryItem[]>;

  updateItem(
    id: string,
    patch: UpdateInventoryItemRepoInput,
  ): Promise<InventoryItem>;

  /** Soft-delete: sets `deletedAt`. Never a hard delete. */
  softDeleteItem(id: string): Promise<void>;

  /** Persists an immutable movement row. There is no update/delete for
   * movements — correcting one means recording a new ADJUSTMENT. */
  createMovement(
    input: CreateInventoryMovementRepoInput,
  ): Promise<InventoryMovement>;

  /** All movements for one item, ordered by `occurredAt` DESC. */
  listMovements(itemId: string): Promise<InventoryMovement[]>;

  /**
   * Current stock for ONE item = Σ signed(movement) — see `signedQuantity`
   * in `../stock-signing`. Returns `0` for an item with no movements.
   */
  sumSignedQuantity(itemId: string): Promise<number>;

  /**
   * Current stock for ALL items in a single aggregation query, keyed by
   * `itemId` — this is what lets `ListInventoryItemsUseCase` compute
   * stock/lowStock for every item without an N+1 (one query for the items,
   * one query for every item's stock, regardless of how many items there
   * are). An item with no movements is simply absent from the map; callers
   * default the lookup to `0`.
   */
  sumSignedQuantityAll(): Promise<Record<string, number>>;
}
