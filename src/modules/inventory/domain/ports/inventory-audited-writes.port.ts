import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { InventoryItem } from '../entities/inventory-item.entity';
import type { InventoryMovement } from '../entities/inventory-movement.entity';
import type {
  CreateInventoryItemRepoInput,
  CreateInventoryMovementRepoInput,
  UpdateInventoryItemRepoInput,
} from './inventory-repository.port';

export const INVENTORY_AUDITED_WRITES = Symbol('INVENTORY_AUDITED_WRITES');

/**
 * DX-360: las escrituras del inventario, cada una con su evento de auditoría
 * (INVENTORY_ITEM / INVENTORY_MOVEMENT) en la MISMA transacción que el
 * cambio, en la sede del artículo. Puerto aparte de `InventoryRepository`
 * (que queda para las lecturas): el inventario es configuración de la sede
 * y su auditoría no se mezcla con las consultas de stock. Quien escribe es
 * siempre el actor de `audit`, nunca un id del cliente.
 */
export interface InventoryAuditedWrites {
  createItem(
    input: Omit<CreateInventoryItemRepoInput, 'createdById'>,
    audit: AuditRequestContext,
  ): Promise<InventoryItem>;

  /** Sin evento si el cambio no cambia nada. 404 si el artículo ya no está. */
  updateItem(
    id: string,
    patch: UpdateInventoryItemRepoInput,
    audit: AuditRequestContext,
  ): Promise<InventoryItem>;

  /** Soft-delete: sets `deletedAt`. Never a hard delete. */
  softDeleteItem(id: string, audit: AuditRequestContext): Promise<void>;

  /** Movimiento inmutable; corregirlo es registrar un ADJUSTMENT nuevo. */
  createMovement(
    input: Omit<CreateInventoryMovementRepoInput, 'createdById'>,
    audit: AuditRequestContext,
  ): Promise<InventoryMovement>;
}
