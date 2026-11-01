import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  InventoryRepository,
  ListInventoryItemsRepoParams,
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

export function mapToEntity(item: PrismaInventoryItem): InventoryItem {
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
export function mapMovementToEntity(
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

/**
 * Lecturas del inventario. Las escrituras, con su auditoría en la misma
 * transacción, están en `PrismaInventoryAuditedWritesRepository` (DX-360).
 */
@Injectable()
export class PrismaInventoryRepository implements InventoryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findItemById(id: string): Promise<InventoryItem | null> {
    const item = await this.prisma.runWithTenant(async (tx) => {
      return tx.inventoryItem.findFirst({
        where: { id, deletedAt: null },
      });
    });
    // DX-089: el stock es de una sede; un ítem de otra no permitida es 403
    // (no 404: existe). Leer, editar, borrar y moverlo pasan por aquí.
    if (item) this.tenantContext.assertLocationAllowed(item.locationId);
    return item ? mapToEntity(item) : null;
  }

  async listItems(
    params?: ListInventoryItemsRepoParams,
  ): Promise<InventoryItem[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const items = await tx.inventoryItem.findMany({
        // El stock es físico: pertenece a una sede.
        where: {
          deletedAt: null,
          ...this.tenantContext.locationScope(),
          ...(params?.query
            ? {
                OR: [
                  {
                    name: {
                      contains: params.query,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    sku: {
                      contains: params.query,
                      mode: 'insensitive' as const,
                    },
                  },
                ],
              }
            : {}),
        },
        // Orden estable: sin él, cortar por página podría repetir o
        // saltarse filas entre una llamada y la siguiente.
        orderBy: { name: 'asc' },
      });
      return items.map(mapToEntity);
    });
  }

  // listMovements NO filtra por sede: los movimientos ya cuelgan de un ítem,
  // que a su vez es de una sede — volver a filtrar sería redundante y podría
  // ocultar el historial del propio ítem que se está consultando.
  async listMovements(itemId: string): Promise<InventoryMovement[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const movements = await tx.inventoryMovement.findMany({
        where: { itemId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
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
