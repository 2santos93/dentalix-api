/**
 * Monedas que se PINTAN sin decimales: las de `minorUnits = 0` de
 * `prisma/reference/iso4217.ts`. Es `minorUnitsZero` de
 * `prisma/reference/iso4217-zero-decimal.json` (la web tiene la misma copia);
 * la spec comprueba que coinciden. El JSON no se importa en runtime.
 */
export const ISO_ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'AFN',
  'ALL',
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'IRR',
  'ISK',
  'JPY',
  'KMF',
  'KPW',
  'KRW',
  'LAK',
  'LBP',
  'MGA',
  'MMK',
  'PYG',
  'RSD',
  'RWF',
  'SOS',
  'SYP',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
  'YER',
]);

/** Las que ya se redondeaban al entero antes de G1; solo cuentan para redondear. */
const PREVIOUS_ZERO_DECIMAL_CURRENCIES = ['COP', 'CLP', 'JPY', 'KRW', 'PYG'];

/**
 * Monedas que se REDONDEAN sin decimales: `ISO_ZERO_DECIMAL_CURRENCIES` más
 * las anteriores a G1 (`COP` se conserva aunque CLDR le dé 2: los presupuestos
 * se redondean al peso).
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  ...ISO_ZERO_DECIMAL_CURRENCIES,
  ...PREVIOUS_ZERO_DECIMAL_CURRENCIES,
]);

export function currencyDecimals(currency: string): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}
