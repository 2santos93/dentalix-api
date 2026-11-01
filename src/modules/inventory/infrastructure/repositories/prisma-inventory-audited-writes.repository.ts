import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { lockRow } from '../../../../shared/prisma/lock-row';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { InventoryAuditedWrites } from '../../domain/ports/inventory-audited-writes.port';
import type {
  CreateInventoryItemRepoInput,
  CreateInventoryMovementRepoInput,
  UpdateInventoryItemRepoInput,
} from '../../domain/ports/inventory-repository.port';
import type { InventoryItem } from '../../domain/entities/inventory-item.entity';
import type { InventoryMovement } from '../../domain/entities/inventory-movement.entity';
import {
  INVENTORY_ITEM_HIDDEN_FIELDS,
  inventoryItemSnapshot,
} from '../../domain/inventory-audit';
import {
  mapMovementToEntity,
  mapToEntity,
} from './prisma-inventory.repository';

type ItemRow = Prisma.InventoryItemGetPayload<Record<string, never>>;

const snapshotOf = (row: ItemRow) =>
  inventoryItemSnapshot({ ...row, minStock: row.minStock.toNumber() });

/**
 * DX-360: escrituras del inventario con su evento de auditoría en la misma
 * transacción, en la sede del artículo. Mismas reglas de escritura que tenía
 * `PrismaInventoryRepository` (tenant y sede del contexto, nunca del cliente;
 * borrado blando; movimientos inmutables).
 */
@Injectable()
export class PrismaInventoryAuditedWritesRepository implements InventoryAuditedWrites {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito; sale del contexto del request. */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  private async liveItem(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<ItemRow> {
    // DX-360: el antes, con la fila bloqueada hasta el final de la edición.
    await lockRow(tx, 'inventory_items', id);
    const row = await tx.inventoryItem.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Inventory item not found');
    return row;
  }

  createItem(
    input: Omit<CreateInventoryItemRepoInput, 'createdById'>,
    audit: AuditRequestContext,
  ): Promise<InventoryItem> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.inventoryItem.create({
        data: {
          // Sede del request si el cliente la fijó (X-Location-Id, ya validada
          // contra esta clínica); si no, la de escritura de la sesión (DX-089).
          locationId: await this.tenantContext.writeLocationId(tx),
          tenantId,
          name: input.name,
          sku: input.sku,
          unit: input.unit,
          minStock: input.minStock,
          notes: input.notes,
          createdById: audit.actor.userId,
        },
      });
      await writeAuditEvent(
        tx,
        configAuditEvent(audit, {
          action: 'CREATE',
          resourceType: 'INVENTORY_ITEM',
          resourceId: row.id,
          locationId: row.locationId,
          reason: 'INVENTORY_ITEM_CREATED',
          after: snapshotOf(row),
          hiddenFields: INVENTORY_ITEM_HIDDEN_FIELDS,
        }),
      );
      return mapToEntity(row);
    });
  }

  updateItem(
    id: string,
    patch: UpdateInventoryItemRepoInput,
    audit: AuditRequestContext,
  ): Promise<InventoryItem> {
    return this.prisma.runWithTenant(async (tx) => {
      const before = await this.liveItem(tx, id);
      const after = await tx.inventoryItem.update({
        where: { id },
        data: patch,
      });
      const event = configAuditEvent(audit, {
        action: 'UPDATE',
        resourceType: 'INVENTORY_ITEM',
        resourceId: id,
        locationId: after.locationId,
        reason: 'INVENTORY_ITEM_UPDATED',
        before: snapshotOf(before),
        after: snapshotOf(after),
        hiddenFields: INVENTORY_ITEM_HIDDEN_FIELDS,
      });
      if (event) await writeAuditEvent(tx, event);
      return mapToEntity(after);
    });
  }

  async softDeleteItem(id: string, audit: AuditRequestContext): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      const before = await this.liveItem(tx, id);
      await tx.inventoryItem.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await writeAuditEvent(
        tx,
        configAuditEvent(audit, {
          action: 'DELETE',
          resourceType: 'INVENTORY_ITEM',
          resourceId: id,
          locationId: before.locationId,
          reason: 'INVENTORY_ITEM_DELETED',
          before: snapshotOf(before),
          hiddenFields: INVENTORY_ITEM_HIDDEN_FIELDS,
        }),
      );
    });
  }

  createMovement(
    input: Omit<CreateInventoryMovementRepoInput, 'createdById'>,
    audit: AuditRequestContext,
  ): Promise<InventoryMovement> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.inventoryMovement.create({
        data: {
          // Sede del request si el cliente la fijó (X-Location-Id, ya validada
          // contra esta clínica); si no, la de escritura de la sesión (DX-089).
          locationId: await this.tenantContext.writeLocationId(tx),
          tenantId,
          itemId: input.itemId,
          type: input.type,
          quantity: input.quantity,
          reason: input.reason,
          createdById: audit.actor.userId,
        },
      });
      const movement = mapMovementToEntity(row);
      // El motivo es texto libre: no entra en el evento (DX-360).
      await writeAuditEvent(
        tx,
        configAuditEvent(audit, {
          action: 'CREATE',
          resourceType: 'INVENTORY_MOVEMENT',
          resourceId: movement.id,
          locationId: row.locationId,
          reason: 'INVENTORY_MOVEMENT_RECORDED',
          after: { type: movement.type, quantity: movement.quantity },
          extra: { params: { itemId: movement.itemId } },
        }),
      );
      return movement;
    });
  }
}
