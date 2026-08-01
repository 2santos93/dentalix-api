import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreateInventoryItemRepoInput,
  CreateInventoryMovementRepoInput,
  InventoryRepository,
  UpdateInventoryItemRepoInput,
} from '../../domain/ports/inventory-repository.port';
import { InventoryItem } from '../../domain/entities/inventory-item.entity';
import { InventoryMovement } from '../../domain/entities/inventory-movement.entity';
import { signedQuantity } from '../../domain/stock-signing';

type PrismaInventoryItem = Prisma.InventoryItemGetPayload<
  Record<string, never>
>;
type PrismaInventoryMovement = Prisma.InventoryMovementGetPayload<
  Record<string, never>
>;

function mapToEntity(item: PrismaInventoryItem): InventoryItem {
  return {
    id: item.id,
    tenantId: item.tenantId,
    name: item.name,
    sku: item.sku,
    unit: item.unit,
    minStock: item.minStock.toNumber(),
    notes: item.notes,
    createdById: item.createdById,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// `quantity` is a Prisma `Decimal` at the DB layer; the API-facing entity
// exposes it as a plain `number` — same convention as
// `PrismaTreatmentPlanRepository.mapItemToEntity` for `price`.
function mapMovementToEntity(
  movement: PrismaInventoryMovement,
): InventoryMovement {
  return {
    id: movement.id,
    tenantId: movement.tenantId,
    itemId: movement.itemId,
    type: movement.type,
    quantity: movement.quantity.toNumber(),
    reason: movement.reason,
    occurredAt: movement.occurredAt,
    createdById: movement.createdById,
    createdAt: movement.createdAt,
  };
}

@Injectable()
export class PrismaInventoryRepository implements InventoryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE, which RLS
   * filters transparently — an INSERT still needs the app to supply it
   * explicitly. We never take it from the input (never from the client); we
   * read it from the same request-scoped context that `runWithTenant(fn)`
   * uses to set `app.current_tenant`, so the value written always matches
   * the GUC the WITH CHECK policy validates against (same convention as
   * PrismaTreatmentPlanRepository / PrismaSaleRepository).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async createItem(
    input: CreateInventoryItemRepoInput,
  ): Promise<InventoryItem> {
    const tenantId = this.requireTenantId();
    const item = await this.prisma.runWithTenant(async (tx) => {
      return tx.inventoryItem.create({
        data: {
          // Fase 1 multi-sede: la sede sale de la única del tenant; en la fase 2
          // vendrá del request ya validada (ver default-location.ts).
          locationId: await resolveDefaultLocationId(tx),
          tenantId,
          name: input.name,
          sku: input.sku,
          unit: input.unit,
          minStock: input.minStock,
          notes: input.notes,
          createdById: input.createdById,
        },
      });
    });
    return mapToEntity(item);
  }

  async findItemById(id: string): Promise<InventoryItem | null> {
    const item = await this.prisma.runWithTenant(async (tx) => {
      return tx.inventoryItem.findFirst({
        where: { id, deletedAt: null },
      });
    });
    return item ? mapToEntity(item) : null;
  }

  async listItems(): Promise<InventoryItem[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const items = await tx.inventoryItem.findMany({
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
      });
      return items.map(mapToEntity);
    });
  }

  async updateItem(
    id: string,
    patch: UpdateInventoryItemRepoInput,
  ): Promise<InventoryItem> {
    return this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.inventoryItem.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Inventory item not found');
      }

      const item = await tx.inventoryItem.update({
        where: { id },
        data: patch,
      });
      return mapToEntity(item);
    });
  }

  async softDeleteItem(id: string): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.inventoryItem.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Inventory item not found');
      }

      await tx.inventoryItem.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });
  }

  async createMovement(
    input: CreateInventoryMovementRepoInput,
  ): Promise<InventoryMovement> {
    const tenantId = this.requireTenantId();
    const movement = await this.prisma.runWithTenant(async (tx) => {
      return tx.inventoryMovement.create({
        data: {
          // Fase 1 multi-sede: la sede sale de la única del tenant; en la fase 2
          // vendrá del request ya validada (ver default-location.ts).
          locationId: await resolveDefaultLocationId(tx),
          tenantId,
          itemId: input.itemId,
          type: input.type,
          quantity: input.quantity,
          reason: input.reason,
          createdById: input.createdById,
        },
      });
    });
    return mapMovementToEntity(movement);
  }

  async listMovements(itemId: string): Promise<InventoryMovement[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const movements = await tx.inventoryMovement.findMany({
        where: { itemId },
        orderBy: { occurredAt: 'desc' },
      });
      return movements.map(mapMovementToEntity);
    });
  }

  /**
   * Aggregates in the DB via `groupBy(['type'])` instead of pulling every
   * movement row over the wire — one query regardless of how many movements
   * the item has. Summing `quantity` per `type` first and THEN applying
   * `signedQuantity` per group (rather than per row) is mathematically
   * equivalent because summation is linear, e.g.
   * `Σ signed(m) = Σ_type signed(type, Σ_{m.type=type} m.quantity)`.
   */
  async sumSignedQuantity(itemId: string): Promise<number> {
    return this.prisma.runWithTenant(async (tx) => {
      const groups = await tx.inventoryMovement.groupBy({
        by: ['type'],
        where: { itemId },
        _sum: { quantity: true },
      });
      return groups.reduce((total, group) => {
        const sum = group._sum.quantity?.toNumber() ?? 0;
        return total + signedQuantity(group.type, sum);
      }, 0);
    });
  }

  /**
   * Same `groupBy` aggregation as `sumSignedQuantity`, but grouped by
   * `[itemId, type]` across ALL items in one query — this is what lets
   * `ListInventoryItemsUseCase` compute stock for every item without an
   * N+1. An item with no movements never appears in any group and is
   * therefore simply absent from the returned map.
   */
  async sumSignedQuantityAll(): Promise<Record<string, number>> {
    return this.prisma.runWithTenant(async (tx) => {
      const groups = await tx.inventoryMovement.groupBy({
        by: ['itemId', 'type'],
        _sum: { quantity: true },
      });
      const totals: Record<string, number> = {};
      for (const group of groups) {
        const sum = group._sum.quantity?.toNumber() ?? 0;
        const delta = signedQuantity(group.type, sum);
        totals[group.itemId] = (totals[group.itemId] ?? 0) + delta;
      }
      return totals;
    });
  }
}
