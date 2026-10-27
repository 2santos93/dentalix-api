/**
 * Monedas que se cobran sin decimales: las de `minorUnits = 0` de la lista ISO
 * 4217 de `prisma/reference/iso4217.ts` (R7). `COP` se conserva aunque CLDR le
 * dé 2: en Colombia no circulan centavos y los presupuestos se redondean al
 * peso. La spec de la lista lo comprueba.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'AFN',
  'ALL',
  'BIF',
  'CLP',
  'COP',
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

export function currencyDecimals(currency: string): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}
