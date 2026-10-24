/**
 * Monedas que se cobran sin decimales. COP: en Colombia no circulan centavos y
 * los presupuestos se redondean al peso; CLP no tiene unidad menor.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['COP', 'CLP', 'JPY', 'KRW', 'PYG']);

export function currencyDecimals(currency: string): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}
