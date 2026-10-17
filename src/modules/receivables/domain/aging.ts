import { parseCivilDate } from '../../../shared/time/civil-day';

/*
 * Tramos de la cartera por antigüedad (DX-145). Fijos, como en Open Dental:
 * 0–30, 31–60, 61–90 y más de 90 días, más «por vencer» para las cuotas de un
 * plan de pagos que todavía no vencen (se deben, pero aún no son exigibles).
 * Sin él, el total de la fila no cuadraría con el saldo del estado de cuenta.
 *
 * La antigüedad de una línea de deuda se cuenta en DÍAS CIVILES de la zona de
 * la sede de la deuda: desde el vencimiento de la cuota o desde la fecha del
 * saldo del plan (ver compute-patient-aging.ts), hasta «hoy» en esa sede.
 */
export const AGING_BUCKETS = [
  'current',
  'days0to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

export type AgingBuckets = Record<AgingBucket, number>;

export interface AgedAmount {
  /** Días civiles desde que la línea es exigible (negativo = aún no vence). */
  ageDays: number;
  /** `false` para una cuota que todavía no vence. */
  due: boolean;
}

const DAY_MS = 86_400_000;
const MAX_MEMO = 20_000;
// Día civil → días desde 1970. La cartera mide decenas de miles de líneas por
// petición con pocos días distintos: validar y convertir cada texto una sola
// vez (docs/perf/DX-145.md). Acotado para no crecer sin fin en el proceso.
const epochDays = new Map<string, number>();

function epochDayOf(day: string): number {
  const cached = epochDays.get(day);
  if (cached !== undefined) return cached;
  if (parseCivilDate(day) === null) {
    throw new RangeError(`Invalid civil date: ${day}`);
  }
  const value = Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
  if (epochDays.size >= MAX_MEMO) epochDays.clear();
  epochDays.set(day, value);
  return value;
}

/** Días de calendario de `from` a `to` (mismo día = 0; futuro = negativo). */
export function ageInDays(from: string, to: string): number {
  return epochDayOf(to) - epochDayOf(from);
}

export function bucketOf(line: AgedAmount): AgingBucket {
  if (!line.due) return 'current';
  if (line.ageDays <= 30) return 'days0to30';
  if (line.ageDays <= 60) return 'days31to60';
  if (line.ageDays <= 90) return 'days61to90';
  return 'over90';
}

export function emptyBuckets(): AgingBuckets {
  return {
    current: 0,
    days0to30: 0,
    days31to60: 0,
    days61to90: 0,
    over90: 0,
  };
}

// Montos Decimal(14,2): se suman en centavos enteros (mismo criterio que el
// estado de cuenta y la caja) para que 0.1 + 0.2 sea 0.3.
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Suma `amount` al tramo, exacto en centavos. Muta `buckets`. */
export function addToBuckets(
  buckets: AgingBuckets,
  bucket: AgingBucket,
  amount: number,
): void {
  buckets[bucket] = fromCents(toCents(buckets[bucket]) + toCents(amount));
}
