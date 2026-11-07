import {
  bigCents,
  unitCents,
  unitsToAmount,
  type RoundingDigits,
} from './line-rounding';

/**
 * Conversión de un importe con una tasa CONGELADA (DX-513-bis). Las tasas van,
 * como en todo Dentalix, en «unidades por 1 USD» (DX-374/375) con los 8
 * decimales de su columna (`Decimal(18,8)`).
 */
export interface RatePair {
  /** Unidades de la moneda de origen por 1 USD. */
  fromPerBase: number;
  /** Unidades de la moneda de destino por 1 USD. */
  toPerBase: number;
}

/** Una tasa en enteros de 1e-8 (exacta con los 8 decimales de su columna). */
function rateUnits(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`Tasa de cambio no válida: ${rate}.`);
  }
  return BigInt(Math.round(rate * 1e8));
}

/** Una tasa con los 8 decimales de su columna (`Number` de ese decimal). */
export function toRateColumn(rate: number): number {
  return Number(rate.toFixed(8));
}

/**
 * `amount` de la moneda de origen en la de destino (`amount ÷ from × to`),
 * redondeado UNA sola vez a los `digits` de redondeo de la moneda de destino,
 * la mitad hacia arriba (DX-340), en enteros: sin `round2` intermedio (doble
 * redondeo) ni deriva de coma flotante. Solo importes ≥ 0.
 */
export function convertAtRate(
  amount: number,
  rate: RatePair,
  digits: RoundingDigits,
): number {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`Importe no válido para convertir: ${amount}.`);
  }
  const from = rateUnits(rate.fromPerBase);
  const to = rateUnits(rate.toPerBase);
  // céntimos de origen × to / from = céntimos de destino; en unidades de la
  // moneda de destino, la mitad hacia arriba: (2·n + d) / (2·d).
  const numerator = bigCents(amount) * to;
  const denominator = from * unitCents(digits);
  const units = (2n * numerator + denominator) / (2n * denominator);
  return unitsToAmount(units, digits);
}
