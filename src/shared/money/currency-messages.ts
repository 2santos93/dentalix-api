/**
 * DX-517-bis: los 400 de moneda de toda la API, en español neutro y sin el
 * nombre técnico del campo ni ningún código o país escrito a mano. Un único
 * sitio para que la misma falta diga lo mismo en cobros, caja, gastos,
 * informes, listas de precios o planes.
 */

/** El código no tiene forma de moneda (o no es un código ISO 4217 real). */
export const CURRENCY_CODE_MESSAGE =
  'La moneda tiene que ser un código ISO 4217 de tres letras en mayúsculas.';

/** El importe de un abono no es un número finito mayor que 0. */
export const PAYMENT_AMOUNT_MESSAGE =
  'El importe tiene que ser un número mayor que 0.';

/** El importe (conversión de moneda) no es un número finito mayor o igual que 0. */
export const AMOUNT_NON_NEGATIVE_MESSAGE =
  'El importe tiene que ser un número mayor o igual que 0.';

/** El pago inicial de un plan de pagos no es un número finito mayor o igual que 0. */
export const DOWN_PAYMENT_MESSAGE =
  'El pago inicial tiene que ser un número mayor o igual que 0.';

/** El total a financiar no es un número finito mayor o igual que 0. */
export const TOTAL_TO_FINANCE_MESSAGE =
  'El total a financiar tiene que ser un número mayor o igual que 0.';

/** El total a financiar (o el del plan, por defecto) es 0. */
export const TOTAL_TO_FINANCE_POSITIVE_MESSAGE =
  'El total a financiar tiene que ser mayor que 0.';

/** El pago inicial pasa del total a financiar. */
export const DOWN_PAYMENT_EXCEEDS_MESSAGE =
  'El pago inicial no puede superar el total a financiar.';

/** Falta la moneda. */
export const CURRENCY_REQUIRED_MESSAGE = 'Indica la moneda.';

/** El código tiene buena forma pero no está en la tabla `currencies`. */
export const UNKNOWN_CURRENCY_MESSAGE =
  'Esa moneda no está en la lista de monedas admitidas.';

/** Una lista de códigos (`?currencies=`) mal formada o demasiado larga. */
export function currencyListMessage(max: number): string {
  return `Las monedas tienen que ser una lista de hasta ${max} códigos ISO 4217 de tres letras, separados por comas.`;
}

/**
 * DX-517-quater: una moneda nombrada que no está en la lista de monedas
 * admitidas (ajustes de la sede, textos de moneda de la clínica).
 */
export function unknownCurrencyNamedMessage(code: string): string {
  return `La moneda ${code} no está en la lista de monedas admitidas.`;
}

/**
 * DX-517-quater: un número con tope de decimales y de valor absoluto (importes,
 * tasas, porcentajes). El máximo sale formateado en español neutro (miles con
 * punto, decimales con coma, sin región), sin nombrar ningún país ni moneda.
 */
export function boundedDecimalMessage(
  maxDecimals: number,
  maxAbs: number,
  subject = 'El valor',
): string {
  // A mano (miles con punto, decimales con coma): sin locale literal.
  const [whole, fraction = ''] = maxAbs.toFixed(maxDecimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const max = fraction === '' ? grouped : `${grouped},${fraction}`;
  const decimals = maxDecimals === 1 ? '1 decimal' : `${maxDecimals} decimales`;
  return `${subject} tiene que ser un número con hasta ${decimals} y no mayor que ${max}.`;
}
