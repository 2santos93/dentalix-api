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

/** Falta la moneda. */
export const CURRENCY_REQUIRED_MESSAGE = 'Indica la moneda.';

/** El código tiene buena forma pero no está en la tabla `currencies`. */
export const UNKNOWN_CURRENCY_MESSAGE =
  'Esa moneda no está en la lista de monedas admitidas.';

/** Una lista de códigos (`?currencies=`) mal formada o demasiado larga. */
export function currencyListMessage(max: number): string {
  return `Las monedas tienen que ser una lista de hasta ${max} códigos ISO 4217 de tres letras, separados por comas.`;
}
