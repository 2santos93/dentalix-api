import { InventoryMovementType } from '@prisma/client';

/**
 * Signed contribution of ONE movement to an item's stock. This is the
 * SINGLE place that encodes the IN/OUT/ADJUSTMENT sign convention — both
 * `PrismaInventoryRepository`'s DB-side aggregation
 * (`sumSignedQuantity`/`sumSignedQuantityAll`) and
 * `InMemoryInventoryRepository`'s in-memory aggregation call this exact
 * function, so the rule can never drift between the two implementations of
 * the port.
 *
 *   - `IN`         → `+quantity` (quantity is always > 0, enforced by
 *                    `RecordInventoryMovementUseCase` before it reaches here)
 *   - `OUT`        → `-quantity` (quantity is always > 0, same enforcement)
 *   - `ADJUSTMENT` → `+quantity` as-is — `quantity` itself carries the sign
 *                    for adjustments (can be negative); only enforced to be
 *                    `!= 0` at input time.
 *
 * v1 deliberately allows the resulting stock to go negative (e.g. an OUT
 * larger than what's on hand, recording a shrinkage/mismatch) — see the
 * plan's "Notas". Nothing here rejects that; the use case does not check
 * the running total before persisting a movement.
 */
export function signedQuantity(
  type: InventoryMovementType,
  quantity: number,
): number {
  switch (type) {
    case 'IN':
      return quantity;
    case 'OUT':
      return -quantity;
    case 'ADJUSTMENT':
      return quantity;
  }
}

/**
 * Σ signed(movement) over an in-memory list of movements. Used by
 * `InMemoryInventoryRepository` (and available to any caller that already
 * holds the full movement list, e.g. tests) — the Prisma repository instead
 * aggregates in the DB via `groupBy` and applies `signedQuantity` per group,
 * which is mathematically equivalent (summation is linear) but avoids
 * pulling every movement row over the wire.
 */
export function sumSignedQuantities(
  movements: { type: InventoryMovementType; quantity: number }[],
): number {
  return movements.reduce(
    (total, movement) =>
      total + signedQuantity(movement.type, movement.quantity),
    0,
  );
}
