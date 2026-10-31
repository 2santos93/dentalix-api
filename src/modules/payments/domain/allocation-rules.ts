import { createHash } from 'node:crypto';
import { TreatmentPlanItemStatus } from '@prisma/client';
import { lineCents } from '../../../shared/money/line-rounding';

// Reglas puras de la imputación de abonos a ítems (DX-051, spec R5, R7, R10,
// R11). Todo en céntimos enteros; sin E/S.

/** Abono NO fijado (manual = false) con base. */
export interface Donor {
  paymentId: string;
  paidAt: Date;
  createdAt: Date;
  baseCents: number;
  allocatedCents: number;
}

export interface AllocatableItem {
  id: string;
  status: 'ACCEPTED' | 'DONE';
  createdAt: Date;
  /** Solo cuenta para DONE; si falta, se usa `createdAt`. */
  completedAt: Date | null;
  billableCents: number;
  allocatedCents: number;
}

export interface AllocationIncrement {
  paymentId: string;
  itemId: string;
  cents: number;
}

const compareStrings = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** El abono más antiguo primero: paidAt, createdAt, id. */
export function orderDonors(donors: Donor[]): Donor[] {
  return [...donors].sort(
    (a, b) =>
      a.paidAt.getTime() - b.paidAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      compareStrings(a.paymentId, b.paymentId),
  );
}

/** DONE por completedAt (o createdAt) y luego ACCEPTED por createdAt; id desempata. */
export function orderItems(items: AllocatableItem[]): AllocatableItem[] {
  const key = (i: AllocatableItem): number =>
    (i.status === 'DONE'
      ? (i.completedAt ?? i.createdAt)
      : i.createdAt
    ).getTime();
  const rank = (i: AllocatableItem): number => (i.status === 'DONE' ? 0 : 1);
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) || key(a) - key(b) || compareStrings(a.id, b.id),
  );
}

/**
 * Reparto de sobrantes (R5): cada donante en orden llena los ítems en orden.
 * Devuelve incrementos (uno por par abono-ítem); nunca mueve ni reduce lo ya
 * imputado. Idempotente: sobre el estado resultante devuelve [].
 */
export function respreadSurplus(
  donors: Donor[],
  items: AllocatableItem[],
): AllocationIncrement[] {
  const free = new Map<string, number>();
  for (const item of items) {
    free.set(item.id, Math.max(0, item.billableCents - item.allocatedCents));
  }
  const orderedItems = orderItems(items);
  const out: AllocationIncrement[] = [];
  for (const donor of orderDonors(donors)) {
    let surplus = Math.max(0, donor.baseCents - donor.allocatedCents);
    for (const item of orderedItems) {
      if (surplus === 0) break;
      const take = Math.min(surplus, free.get(item.id) ?? 0);
      if (take <= 0) continue;
      out.push({ paymentId: donor.paymentId, itemId: item.id, cents: take });
      surplus -= take;
      free.set(item.id, (free.get(item.id) ?? 0) - take);
    }
  }
  return out;
}

/** Punto fijo roto: algún donante con sobrante y algún ítem con libre. */
export function hasFixedPointViolation(
  donors: Donor[],
  items: AllocatableItem[],
): boolean {
  return (
    donors.some((d) => d.baseCents - d.allocatedCents > 0) &&
    items.some((i) => i.billableCents - i.allocatedCents > 0)
  );
}

export type AllocationViolationCode =
  | 'NO_RATE'
  | 'DUPLICATE'
  | 'TOO_MANY'
  | 'NOT_IN_PLAN'
  | 'PROPOSED'
  | 'OVER_ITEM'
  | 'OVER_PAYMENT';

export interface AllocationViolation {
  code: AllocationViolationCode;
  freeCents?: number;
  sumCents?: number;
}

export const MAX_ALLOCATION_LINES = 200;

export interface ManualAllocationInput {
  baseCents: number | null;
  lines: { itemId: string; cents: number }[];
  /** `freeCents`: libre del ítem sin contar las imputaciones de este abono. */
  items: Map<
    string,
    { status: TreatmentPlanItemStatus | 'MISSING'; freeCents: number }
  >;
}

/** Valida una reasignación manual (R10); devuelve la primera violación. */
export function validateManualAllocation(
  input: ManualAllocationInput,
): AllocationViolation | null {
  const { baseCents, lines, items } = input;
  if (baseCents === null) return { code: 'NO_RATE' };
  if (lines.length > MAX_ALLOCATION_LINES) return { code: 'TOO_MANY' };
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) {
    return { code: 'DUPLICATE' };
  }
  for (const line of lines) {
    const item = items.get(line.itemId);
    if (!item || item.status === 'MISSING') return { code: 'NOT_IN_PLAN' };
    if (item.status === TreatmentPlanItemStatus.PROPOSED) {
      return { code: 'PROPOSED' };
    }
    if (line.cents > item.freeCents) {
      return { code: 'OVER_ITEM', freeCents: item.freeCents };
    }
  }
  const sumCents = lines.reduce((sum, l) => sum + l.cents, 0);
  if (sumCents > baseCents) return { code: 'OVER_PAYMENT', sumCents };
  return null;
}

/** SHA-256 hex del modo y las líneas ordenadas por ítem (R11). */
export function allocationVersion(input: {
  manual: boolean;
  lines: { itemId: string; cents: number }[];
}): string {
  const body = [...input.lines]
    .sort((a, b) => compareStrings(a.itemId, b.itemId))
    .map((l) => `${l.itemId}:${l.cents}`)
    .join('|');
  return createHash('sha256')
    .update(`${input.manual ? 'manual' : 'auto'};${body}`)
    .digest('hex');
}

/** Facturable de un ítem en céntimos: 0 si no es ACCEPTED/DONE vivo o el plan no es cobrable. */
export function itemBillableCents(
  item: {
    status: TreatmentPlanItemStatus;
    price: number;
    discount: number;
    deletedAt: Date | null;
  },
  planBillable: boolean,
): number {
  if (!planBillable || item.deletedAt !== null) return 0;
  if (
    item.status !== TreatmentPlanItemStatus.ACCEPTED &&
    item.status !== TreatmentPlanItemStatus.DONE
  ) {
    return 0;
  }
  // DX-340: la línea del ítem, la misma de todos los documentos.
  return Math.max(0, lineCents(item));
}
