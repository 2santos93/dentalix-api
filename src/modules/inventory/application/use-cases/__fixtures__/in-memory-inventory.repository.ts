import { InventoryMovementType } from '@prisma/client';
import { InventoryItem } from '../../../domain/entities/inventory-item.entity';
import { InventoryMovement } from '../../../domain/entities/inventory-movement.entity';
import {
  CreateInventoryItemRepoInput,
  CreateInventoryMovementRepoInput,
  InventoryRepository,
  ListInventoryItemsRepoParams,
  UpdateInventoryItemRepoInput,
} from '../../../domain/ports/inventory-repository.port';
import { signedQuantity } from '../../../domain/stock-signing';

// `InventoryItem` (the API-facing entity) deliberately has no `deletedAt`
// field — same convention as TreatmentPlan/Sale. The fake still has to
// honour "non-deleted only" like the real Prisma repo, so it tracks
// `deletedAt` on the stored row and strips it via `toItemEntity` (mirrors
// `mapToEntity` in prisma-inventory.repository.ts). Movements have no
// `deletedAt` at all (immutable), matching the real schema.
type StoredItem = InventoryItem & { deletedAt: Date | null };

let seq = 0;
const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Real in-memory fake for `InventoryRepository` — implements ACTUAL
 * filtering + aggregation logic (not a canned stub), so use-case specs built
 * on it genuinely exercise `deletedAt:null` filtering AND the signed-sum
 * stock computation via `signedQuantity` (the same helper the Prisma repo
 * uses), proving the two aggregation paths can't drift apart. Mirrors
 * `PrismaInventoryRepository`'s semantics.
 */
export class InMemoryInventoryRepository implements InventoryRepository {
  private readonly items: StoredItem[] = [];
  private readonly movements: InventoryMovement[] = [];

  /** Test spy: the `params` the use case last passed to `listItems`, so a
   * spec can assert the text filter reached the repo (that's where
   * filtering is supposed to happen — see the port's docs). */
  lastListItemsParams: ListInventoryItemsRepoParams | undefined;

  /** Test helper: seed an item row directly, bypassing use-case validation. */
  seedItem(overrides: Partial<StoredItem> = {}): InventoryItem {
    const row: StoredItem = {
      id: overrides.id ?? `item-seed-${++seq}`,
      tenantId: overrides.tenantId ?? 't1',
      name: overrides.name ?? 'Seed item',
      sku: overrides.sku ?? null,
      unit: overrides.unit ?? 'unidad',
      minStock: overrides.minStock ?? 0,
      notes: overrides.notes ?? null,
      createdById: overrides.createdById ?? null,
      createdAt: overrides.createdAt ?? NOW,
      updatedAt: overrides.updatedAt ?? NOW,
      deletedAt: overrides.deletedAt ?? null,
    };
    this.items.push(row);
    return this.toItemEntity(row);
  }

  /** Test helper: seed a movement row directly, bypassing use-case
   * validation — lets specs set up a stock history without going through
   * `RecordInventoryMovementUseCase`. */
  seedMovement(overrides: Partial<InventoryMovement> = {}): InventoryMovement {
    const row: InventoryMovement = {
      id: overrides.id ?? `movement-seed-${++seq}`,
      tenantId: overrides.tenantId ?? 't1',
      itemId: overrides.itemId ?? 'item-seed-1',
      type: overrides.type ?? InventoryMovementType.IN,
      quantity: overrides.quantity ?? 1,
      reason: overrides.reason ?? null,
      occurredAt: overrides.occurredAt ?? NOW,
      createdById: overrides.createdById ?? null,
      createdAt: overrides.createdAt ?? NOW,
    };
    this.movements.push(row);
    return row;
  }

  // Explicit field-by-field mapping (mirrors `mapToEntity` in the Prisma
  // repo) rather than destructuring off `deletedAt`, so it stays obviously
  // in sync with the entity shape.
  private toItemEntity(row: StoredItem): InventoryItem {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      sku: row.sku,
      unit: row.unit,
      minStock: row.minStock,
      notes: row.notes,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  createItem(input: CreateInventoryItemRepoInput): Promise<InventoryItem> {
    const row: StoredItem = {
      id: `item-${++seq}`,
      tenantId: 't1',
      name: input.name,
      sku: input.sku ?? null,
      unit: input.unit,
      minStock: input.minStock,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    this.items.push(row);
    return Promise.resolve(this.toItemEntity(row));
  }

  findItemById(id: string): Promise<InventoryItem | null> {
    const row = this.items.find((i) => i.id === id && i.deletedAt === null);
    return Promise.resolve(row ? this.toItemEntity(row) : null);
  }

  listItems(params?: ListInventoryItemsRepoParams): Promise<InventoryItem[]> {
    this.lastListItemsParams = params;
    const query = params?.query?.toLowerCase();
    const rows = this.items
      .filter((i) => i.deletedAt === null)
      .filter(
        (i) =>
          !query ||
          i.name.toLowerCase().includes(query) ||
          (i.sku?.toLowerCase().includes(query) ?? false),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => this.toItemEntity(i));
    return Promise.resolve(rows);
  }

  updateItem(
    id: string,
    patch: UpdateInventoryItemRepoInput,
  ): Promise<InventoryItem> {
    const row = this.items.find((i) => i.id === id && i.deletedAt === null);
    if (!row) {
      return Promise.reject(
        new Error(`InMemoryInventoryRepository.updateItem: not found ${id}`),
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
          `InMemoryInventoryRepository.softDeleteItem: not found ${id}`,
        ),
      );
    }
    row.deletedAt = NOW;
    return Promise.resolve();
  }

  createMovement(
    input: CreateInventoryMovementRepoInput,
  ): Promise<InventoryMovement> {
    const row: InventoryMovement = {
      id: `movement-${++seq}`,
      tenantId: 't1',
      itemId: input.itemId,
      type: input.type,
      quantity: input.quantity,
      reason: input.reason ?? null,
      occurredAt: NOW,
      createdById: input.createdById ?? null,
      createdAt: NOW,
    };
    this.movements.push(row);
    return Promise.resolve(row);
  }

  listMovements(itemId: string): Promise<InventoryMovement[]> {
    const rows = this.movements
      .filter((m) => m.itemId === itemId)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return Promise.resolve(rows);
  }

  // REAL signed-sum aggregation (not a canned number) — calls the exact same
  // `signedQuantity` helper the Prisma repo's `groupBy` path uses, so a spec
  // that drives stock through this fake genuinely exercises the sign
  // convention rather than a stand-in.
  sumSignedQuantity(itemId: string): Promise<number> {
    const total = this.movements
      .filter((m) => m.itemId === itemId)
      .reduce((sum, m) => sum + signedQuantity(m.type, m.quantity), 0);
    return Promise.resolve(total);
  }

  sumSignedQuantityAll(): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    for (const m of this.movements) {
      totals[m.itemId] =
        (totals[m.itemId] ?? 0) + signedQuantity(m.type, m.quantity);
    }
    return Promise.resolve(totals);
  }
}
