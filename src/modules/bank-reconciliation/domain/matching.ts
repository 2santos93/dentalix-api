/**
 * DX-571: emparejado de movimientos del extracto con abonos. Puro: lo usan el
 * emparejado automático (al importar y «Volver a emparejar») y las cuatro
 * listas del período.
 *
 * - Misma referencia normalizada (DX-395, `normalizeReference`) y no nula.
 * - Importe: |movimiento − cobrado| ≤ tolerancia de la cuenta. «Cobrado» es
 *   lo que llega al banco: importe + ajustes por medio de pago (DX-516).
 * - Fecha: el día del abono (en la zona de su sede) a ≤ `windowDays` días del
 *   día del movimiento.
 * - 1:1. Si hay varios candidatos, gana el par con menos diferencia de
 *   importe, luego de días, luego el más antiguo y, por último, el id: el
 *   resultado no depende del orden de entrada.
 */

/** Días entre el abono y el movimiento para el automático. */
export const AUTO_MATCH_WINDOW_DAYS = 5;
/** Días alrededor del movimiento para buscar candidatos a mano. */
export const CANDIDATE_WINDOW_DAYS = 15;

export interface MovementForMatch {
  id: string;
  bookedOn: string;
  referenceNormalized: string | null;
  amountCents: number;
}

export interface PaymentForMatch {
  id: string;
  paidOn: string;
  referenceNormalized: string | null;
  collectedCents: number;
}

export interface MatchOptions {
  toleranceCents: number;
  windowDays: number;
}

export interface MatchPair {
  movementId: string;
  paymentId: string;
}

const DAY_MS = 86_400_000;

/** Días entre dos fechas AAAA-MM-DD (valor absoluto). */
export function daysBetween(a: string, b: string): number {
  return (
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
    DAY_MS
  );
}

/** AAAA-MM-DD ± días. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

interface Pair {
  m: MovementForMatch;
  p: PaymentForMatch;
  amountDiff: number;
  dayDiff: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePairs(a: Pair, b: Pair, amountFirst: boolean): number {
  const primary = amountFirst
    ? a.amountDiff - b.amountDiff || a.dayDiff - b.dayDiff
    : a.dayDiff - b.dayDiff || a.amountDiff - b.amountDiff;
  return (
    primary ||
    compareText(a.m.bookedOn, b.m.bookedOn) ||
    compareText(a.p.paidOn, b.p.paidOn) ||
    compareText(a.m.id, b.m.id) ||
    compareText(a.p.id, b.p.id)
  );
}

/** Pares de misma referencia dentro de la ventana, agrupados por referencia. */
function sameReferencePairs(
  movements: readonly MovementForMatch[],
  payments: readonly PaymentForMatch[],
  windowDays: number,
): Pair[] {
  const byRef = new Map<string, PaymentForMatch[]>();
  for (const p of payments) {
    if (p.referenceNormalized === null) continue;
    const list = byRef.get(p.referenceNormalized) ?? [];
    list.push(p);
    byRef.set(p.referenceNormalized, list);
  }
  const pairs: Pair[] = [];
  for (const m of movements) {
    if (m.referenceNormalized === null) continue;
    for (const p of byRef.get(m.referenceNormalized) ?? []) {
      const dayDiff = daysBetween(m.bookedOn, p.paidOn);
      if (dayDiff > windowDays) continue;
      pairs.push({
        m,
        p,
        amountDiff: Math.abs(m.amountCents - p.collectedCents),
        dayDiff,
      });
    }
  }
  return pairs;
}

function assign(pairs: Pair[]): Pair[] {
  const usedM = new Set<string>();
  const usedP = new Set<string>();
  const out: Pair[] = [];
  for (const pair of pairs) {
    if (usedM.has(pair.m.id) || usedP.has(pair.p.id)) continue;
    usedM.add(pair.m.id);
    usedP.add(pair.p.id);
    out.push(pair);
  }
  return out;
}

/** Los emparejados automáticos (referencia + importe en tolerancia + fecha). */
export function autoMatch(
  movements: readonly MovementForMatch[],
  payments: readonly PaymentForMatch[],
  options: MatchOptions,
): MatchPair[] {
  const pairs = sameReferencePairs(movements, payments, options.windowDays)
    .filter((pair) => pair.amountDiff <= options.toleranceCents)
    .sort((a, b) => comparePairs(a, b, true));
  return assign(pairs).map(({ m, p }) => ({
    movementId: m.id,
    paymentId: p.id,
  }));
}

export interface PeriodClassification {
  /** Misma referencia y fecha cercana, importe fuera de la tolerancia. */
  amountMismatch: MatchPair[];
  /** Movimientos sin abono (y no en `amountMismatch`). */
  movementsWithoutPayment: string[];
  /** Abonos del período sin movimiento (y no en `amountMismatch`). */
  paymentsWithoutMovement: string[];
}

/**
 * Las tres listas «abiertas» de un período, a partir de lo que NO está
 * emparejado: `movements` del período y `payments` de un rango algo mayor
 * (para ver pares en el borde); `inPeriod` dice qué abonos son del período.
 */
export function classifyPeriod(
  movements: readonly MovementForMatch[],
  payments: readonly PaymentForMatch[],
  inPeriod: (payment: PaymentForMatch) => boolean,
  options: MatchOptions,
): PeriodClassification {
  const mismatch = assign(
    sameReferencePairs(movements, payments, options.windowDays)
      .filter((pair) => pair.amountDiff > options.toleranceCents)
      .sort((a, b) => comparePairs(a, b, false)),
  );
  const pairedM = new Set(mismatch.map((pair) => pair.m.id));
  const pairedP = new Set(mismatch.map((pair) => pair.p.id));
  const byDayThenId =
    <T extends { id: string }>(day: (x: T) => string) =>
    (a: T, b: T) =>
      compareText(day(a), day(b)) || compareText(a.id, b.id);
  return {
    amountMismatch: mismatch
      .sort(
        (a, b) =>
          compareText(a.m.bookedOn, b.m.bookedOn) ||
          compareText(a.m.id, b.m.id),
      )
      .map(({ m, p }) => ({ movementId: m.id, paymentId: p.id })),
    movementsWithoutPayment: movements
      .filter((m) => !pairedM.has(m.id))
      .sort(byDayThenId((m) => m.bookedOn))
      .map((m) => m.id),
    paymentsWithoutMovement: payments
      .filter((p) => !pairedP.has(p.id) && inPeriod(p))
      .sort(byDayThenId((p) => p.paidOn))
      .map((p) => p.id),
  };
}
