import { InventoryMovement } from './inventory-movement.entity';

/**
 * API-facing shape of an InventoryItem. Deliberately NOT the raw Prisma
 * model — same convention as TreatmentPlan/Sale. The bare CRUD operations
 * (`createItem`/`updateItem`/`listItems`/`findItemById` at the repository
 * boundary) return this shape, with no `stock`/`lowStock` attached — those
 * are computed by the use cases (`ListInventoryItemsUseCase`/
 * `GetInventoryItemUseCase`), never stored on the row.
 */
export interface InventoryItem {
  id: string;
  tenantId: string;
  name: string;
  sku: string | null;
  unit: string;
  minStock: number;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Returned by `ListInventoryItemsUseCase` and as the base of
 * `InventoryItemDetail`. `stock` is Σ signed movements (see
 * `signedQuantity`), computed on every read, NEVER persisted on the item
 * row — same "computed, never stored" convention as
 * `TreatmentPlanDetail.total`. `lowStock` is `stock <= minStock`.
 */
export interface InventoryItemWithStock extends InventoryItem {
  stock: number;
  lowStock: boolean;
}

/**
 * Returned by `GetInventoryItemUseCase` — item + computed stock/lowStock +
 * its full (immutable) movement history.
 */
export interface InventoryItemDetail extends InventoryItemWithStock {
  movements: InventoryMovement[];
}
