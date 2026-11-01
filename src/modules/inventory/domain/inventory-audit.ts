import type { ConfigSnapshot } from '../../audit/domain/config-audit';

/** Columnas de un artículo que entran en su foto de auditoría. */
export interface InventoryItemAuditRow {
  name: string;
  sku: string | null;
  unit: string;
  minStock: number;
  notes: string | null;
}

/**
 * DX-360: las notas de un artículo y el motivo de un movimiento son texto
 * libre: solo figuran por su nombre de campo (`changedFields`).
 */
export const INVENTORY_ITEM_HIDDEN_FIELDS = ['notes'] as const;

export function inventoryItemSnapshot(
  item: InventoryItemAuditRow,
): ConfigSnapshot {
  return {
    name: item.name,
    sku: item.sku,
    unit: item.unit,
    minStock: item.minStock,
    notes: item.notes,
  };
}
