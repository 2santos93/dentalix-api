import {
  BIDI_MARKS_RE,
  currencyTextFor,
  moneyDigits,
  moneyWithCurrencyText,
  type CurrencyTexts,
} from './currency-text';
import type { RegionalFormat } from './regional-format';

const codeFormatters = new Map<string, Intl.NumberFormat>();

/**
 * DX-521: un importe con los separadores de la sede y SIEMPRE el código ISO de
 * su moneda («VES 1.234,50», «1.234,50 VES», «USD 1,234.50»), nunca un
 * símbolo: en un producto bimonetario «$» no dice si son pesos o dólares
 * (DX-378). Con un texto propio de la clínica para esa moneda («VES» →
 * «Bs.»), ese texto en el lugar del código (DX-517).
 *
 * Mismo algoritmo y mismos vectores (`receipt-format.cases.json`, copia byte a
 * byte en la web) que `moneyWithCode` de `src/lib/format/sede-number.ts` de la
 * web, así que el papel y el email del recibo dicen lo mismo. `texts`: los de
 * la foto del recibo; sin ellos, el código. Nunca lanza: un código que `Intl`
 * no acepta se pinta tal cual delante de la cifra.
 */
export function moneyWithCode(
  amount: number,
  currency: string,
  fmt: RegionalFormat,
  texts: CurrencyTexts | null | undefined,
): string {
  const text = currencyTextFor(texts, currency);
  if (text !== undefined) {
    return moneyWithCurrencyText(amount, currency, fmt.locale, text);
  }
  const digits = moneyDigits(amount, currency);
  const key = `${fmt.locale}|${currency}|${digits}`;
  try {
    let formatter = codeFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(fmt.locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'code',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        numberingSystem: 'latn',
      });
      codeFormatters.set(key, formatter);
    }
    return formatter.format(amount).replace(BIDI_MARKS_RE, '');
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return `${currency} ${fmt.number(amount, { min: digits, max: digits })}`;
  }
}
