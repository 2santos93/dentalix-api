import { InventoryMovementType } from '@prisma/client';

/**
 * API-facing shape of an InventoryMovement. Deliberately NOT the raw Prisma
 * model — repositories must `mapToEntity` before returning across the port
 * boundary (same convention as TreatmentPlanItem / SaleLineItem). Movements
 * are immutable history: no `deletedAt`, no update path — correcting a past
 * movement means recording a new ADJUSTMENT, never editing an existing row.
 *
 * `quantity` is a plain `number` here (Prisma stores `Decimal(14,3)`). For
 * `IN`/`OUT` it is always > 0; for `ADJUSTMENT` it may be negative — the sign
 * convention lives in ONE place, see `signedQuantity` in
 * `../stock-signing`.
 */
export interface InventoryMovement {
  id: string;
  tenantId: string;
  itemId: string;
  type: InventoryMovementType;
  quantity: number;
  reason: string | null;
  occurredAt: Date;
  createdById: string | null;
  createdAt: Date;
}
