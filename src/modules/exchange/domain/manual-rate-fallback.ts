import { addCivilDays } from '../../../shared/time/civil-day';
import { BASE_CURRENCY } from './exchange-rate-source';

/**
 * DX-384: hasta cuántos días de antigüedad puede tener la última tasa manual
 * que sustituye a la del día de un abono (por clínica; 0 = solo el día
 * exacto). 3 de plataforma: un viernes cubre el sábado, el domingo y el lunes.
 */
export const MANUAL_RATE_MAX_AGE_DEFAULT = 3;
export const MANUAL_RATE_MAX_AGE_MIN = 0;
export const MANUAL_RATE_MAX_AGE_MAX = 30;

export const MANUAL_RATE_MAX_AGE_MESSAGE = `El plazo de la última tasa registrada tiene que ser un número entero de días entre ${MANUAL_RATE_MAX_AGE_MIN} y ${MANUAL_RATE_MAX_AGE_MAX}.`;

export function isValidManualRateMaxAge(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MANUAL_RATE_MAX_AGE_MIN &&
    value <= MANUAL_RATE_MAX_AGE_MAX
  );
}

/** Una tasa manual registrada: unidades de `currency` por 1 USD el día `date`. */
export interface ManualRateRow {
  /** Día civil AAAA-MM-DD. */
  date: string;
  currency: string;
  rate: number;
}

export interface SelectedManualRate {
  rate: number;
  /** Día civil de la tasa elegida (≤ el día pedido). */
  rateDate: string;
}

export interface SelectedManualRates {
  /** Día civil común a todas las tasas elegidas (≤ el día pedido). */
  rateDate: string;
  rates: Record<string, number>;
}

/**
 * Primer día de la ventana: `day − N`, pero nunca antes de `floor`, el día
 * desde el que rige la fuente MANUAL («manual desde»). Una tasa anterior es
 * terreno de DX-402 (respaldo de ese mismo día): el plazo no la usa para otro.
 */
export function windowStart(
  day: string,
  maxAgeDays: number,
  floor: string | null,
): string {
  const oldest = addCivilDays(day, -maxAgeDays);
  return floor !== null && floor > oldest ? floor : oldest;
}

/**
 * DX-384: de las tasas manuales de UNA moneda, la del día `day` o, si no la
 * hay, la de mayor fecha anterior que no sea más antigua que `maxAgeDays`
 * días de calendario. Una tasa posterior a `day` nunca se usa. `null`: sin
 * tasa (se trata como «sin tasa», nunca se convierte 1:1).
 *
 * Los días son civiles (los de la sede del abono): la resta es de calendario,
 * no de instantes.
 */
export function selectManualRate(
  day: string,
  maxAgeDays: number,
  rows: readonly Pick<ManualRateRow, 'date' | 'rate'>[],
): SelectedManualRate | null {
  const oldest = addCivilDays(day, -maxAgeDays);
  let best: SelectedManualRate | null = null;
  for (const row of rows) {
    if (row.date > day || row.date < oldest) continue;
    if (best === null || row.date > best.rateDate) {
      best = { rate: row.rate, rateDate: row.date };
    }
  }
  return best;
}

/**
 * DX-384: las tasas de varias monedas (las dos de un abono: la suya y la de
 * su plan) de UNA misma fecha, la mayor ≤ `day` y dentro del plazo en la que
 * están todas. Una sola fecha porque el abono congela una (`exchangeRateDate`)
 * y los bloqueos de «tasa ya usada» se identifican por (día, moneda): mezclar
 * la tasa del viernes de una moneda con la del jueves de otra no se podría
 * congelar sin perder cuál se usó. USD no lleva tasa. Sin monedas que buscar,
 * la fecha es el propio día. `null` si no hay una fecha con todas.
 */
export function selectManualRatesForPair(
  day: string,
  maxAgeDays: number,
  currencies: readonly string[],
  rows: readonly ManualRateRow[],
  floor: string | null = null,
): SelectedManualRates | null {
  const wanted = [...new Set(currencies)].filter((c) => c !== BASE_CURRENCY);
  if (wanted.length === 0) return { rateDate: day, rates: {} };
  const oldest = windowStart(day, maxAgeDays, floor);
  const byDate = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (row.date > day || row.date < oldest) continue;
    if (!wanted.includes(row.currency)) continue;
    byDate.set(row.date, { ...byDate.get(row.date), [row.currency]: row.rate });
  }
  const dates = [...byDate.keys()].sort().reverse();
  for (const rateDate of dates) {
    const rates = byDate.get(rateDate)!;
    if (wanted.every((c) => rates[c] !== undefined)) return { rateDate, rates };
  }
  return null;
}
