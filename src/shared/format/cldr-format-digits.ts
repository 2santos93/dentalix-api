/**
 * Monedas que se PINTAN sin decimales (DX-340: dígitos de FORMATO, no de
 * redondeo ni minor units ISO): las de `cldrDigits = 0` de
 * `prisma/reference/iso4217.ts`, fijadas en CLDR 47 para que el formato no
 * cambie con el ICU del Node del host (en CLDR 48 RSD pasa a 2). Es
 * `cldrDigitsZero` de `prisma/reference/cldr-format-digits-zero.json` (la web
 * tiene la misma copia); la spec comprueba que coinciden. El JSON no se
 * importa en runtime. Redondear importes es `shared/money/line-rounding.ts`
 * con `currencies.rounding_digits`.
 */
export const CLDR_ZERO_FORMAT_DIGITS: ReadonlySet<string> = new Set([
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
