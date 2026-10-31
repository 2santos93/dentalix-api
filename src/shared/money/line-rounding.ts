import { toCents } from './money';

/**
 * Redondeo por línea (DX-340): la ÚNICA regla de redondeo de importes de
 * Dentalix.
 *
 * 1. Cada LÍNEA (un ítem del plan: precio − descuento) se redondea UNA vez,
 *    cuando se calcula (descuento en bloque, precio por convenio), a los
 *    `roundingDigits` de su moneda (`currencies.rounding_digits`), la mitad
 *    hacia arriba.
 * 2. El TOTAL de cualquier documento (presupuesto, plan, recibo, estado de
 *    cuenta, saldo) es la suma exacta, en céntimos enteros, de sus líneas
 *    guardadas. El total nunca se vuelve a redondear: así todos los
 *    documentos dan la misma cifra y un importe ya guardado no cambia.
 *
 * Cuatro números distintos que no se mezclan (README «Redondeo de importes»):
 * minor units ISO 4217 (`currencies.minor_units`, SIX List One), dígitos de
 * redondeo por línea (`currencies.rounding_digits`, esta regla), dígitos de
 * FORMATO CLDR (`cldr-format-digits-zero.json`, solo para pintar) y el
 * redondeo del efectivo (cashDigits/cashRounding de CLDR: fuera de alcance,
 * la caja cuenta lo que se cobró).
 *
 * Los importes se guardan en `Decimal(14,2)`: `roundingDigits` va de 0 a 2.
 * Una moneda de 3 decimales (KWD, BHD…) no cabe y se rechaza aquí y en la BD
 * (CHECK de `currencies`), nunca se trunca en silencio.
 */
export type RoundingDigits = 0 | 1 | 2;

/** Valida unos dígitos de redondeo: 0, 1 o 2; si no, error explícito. */
export function roundingDigits(digits: number): RoundingDigits {
  if (digits === 0 || digits === 1 || digits === 2) return digits;
  throw new RangeError(
    `Dígitos de redondeo no admitidos: ${digits} (los importes tienen como mucho 2 decimales).`,
  );
}

/** Unidad de la moneda en céntimos: 1 (2 decimales), 10 (1) o 100 (0). */
export function unitCents(digits: RoundingDigits): bigint {
  return 10n ** BigInt(2 - roundingDigits(digits));
}

/** Un % (hasta 2 decimales) en puntos básicos: 7,5 % → 750. */
export function basisPoints(percent: number): bigint {
  return BigInt(Math.round(percent * 100));
}

/** Importe → céntimos BigInt (mismo redondeo que `toCents`). */
export function bigCents(amount: number): bigint {
  return BigInt(toCents(amount));
}

/**
 * Redondea a la unidad de `digits`, la mitad hacia arriba. Notación
 * exponencial: 10.005 → 1000.5 exacto (×100 daría 1000.4999…).
 */
export function roundToDigits(amount: number, digits: RoundingDigits): number {
  const d = roundingDigits(digits);
  return Number(`${Math.round(Number(`${amount}e${d}`))}e-${d}`);
}

/**
 * `cents × bp / 10000` en unidades de la moneda, la mitad hacia arriba
 * (`'half-up'`) o por debajo (`'floor'`), en enteros: 0,5 unidades nunca se
 * pierden por coma flotante. Devuelve UNIDADES (multiplica por `unitCents`).
 */
export function percentOfCentsInUnits(
  cents: bigint,
  bp: bigint,
  digits: RoundingDigits,
  mode: 'half-up' | 'floor',
): bigint {
  const scale = unitCents(digits) * 10000n;
  const numerator = cents * bp;
  return mode === 'half-up'
    ? (numerator + scale / 2n) / scale
    : numerator / scale;
}

/** Unidades de la moneda → importe. */
export function unitsToAmount(units: bigint, digits: RoundingDigits): number {
  return Number(units * unitCents(digits)) / 100;
}

/** Una línea de un documento: precio y descuento guardados. */
export interface MoneyLine {
  price: number;
  discount: number;
}

/** Importe de una línea en céntimos exactos: precio − descuento. */
export function lineCents(line: MoneyLine): number {
  return toCents(line.price) - toCents(line.discount);
}

/** Total de un documento en céntimos: la suma de sus líneas. */
export function linesTotalCents(lines: readonly MoneyLine[]): number {
  return lines.reduce((sum, line) => sum + lineCents(line), 0);
}

/** Total de un documento: la suma exacta de sus líneas. */
export function linesTotal(lines: readonly MoneyLine[]): number {
  return linesTotalCents(lines) / 100;
}
