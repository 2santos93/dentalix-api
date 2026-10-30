/**
 * DX-390: cobro dividido en varias formas de pago con un solo recibo. Cada
 * línea es un abono con su medio, su moneda, su importe y su referencia; el
 * cobro entero se registra en UNA transacción (todas las líneas o ninguna) y
 * emite UN recibo con todas ellas y el total en la moneda del plan.
 */

/** Líneas de un cobro dividido: con una sola es un abono de siempre. */
export const SPLIT_MIN_LINES = 2;
export const SPLIT_MAX_LINES = 5;

export const SPLIT_LINES_COUNT_MESSAGE = `Un cobro dividido lleva de ${SPLIT_MIN_LINES} a ${SPLIT_MAX_LINES} formas de pago.`;

export const SPLIT_LINE_METHOD_REQUIRED_MESSAGE =
  'Cada forma de pago del cobro necesita su medio de pago.';

export const SPLIT_LINES_SAME_REFERENCE_MESSAGE =
  'Dos formas de pago del cobro tienen el mismo medio y la misma referencia. Revisa la referencia de cada una.';

/**
 * 409 con código estable: el total del cobro (en la moneda del plan) supera
 * lo pendiente del plan. Se confirma repitiendo con `confirmCreditBalance`:
 * el excedente queda como saldo a favor del paciente.
 */
export const SPLIT_PAYMENT_EXCEEDS_BALANCE = 'SPLIT_PAYMENT_EXCEEDS_BALANCE';

export const SPLIT_PAYMENT_EXCEEDS_BALANCE_MESSAGE =
  'El total del cobro supera lo pendiente del plan. Confirma que el excedente queda como saldo a favor del paciente.';

const toCents = (value: number): number => Math.round(value * 100);

/**
 * El total del cobro en la moneda del plan: la suma de las líneas ya
 * convertidas con su tasa congelada, al céntimo. `null` si alguna línea quedó
 * «sin tasa» (su equivalente no se conoce todavía).
 */
export function splitTotal(converted: (number | null)[]): number | null {
  if (converted.some((amount) => amount === null)) return null;
  return (
    (converted as number[]).reduce((sum, amount) => sum + toCents(amount), 0) /
    100
  );
}

/**
 * Lo que se sabe que suma el cobro en la moneda del plan: las líneas con tasa
 * (una «sin tasa» no se puede comparar todavía con lo pendiente).
 */
export function knownSplitTotal(converted: (number | null)[]): number {
  return (
    converted.reduce<number>((sum, amount) => sum + toCents(amount ?? 0), 0) /
    100
  );
}

/** ¿Supera `total` lo pendiente del plan (al céntimo)? */
export function exceedsPending(total: number, pending: number): boolean {
  return toCents(total) > Math.max(0, toCents(pending));
}
