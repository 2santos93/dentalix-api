import { CLDR_ZERO_FORMAT_DIGITS } from './cldr-format-digits';

/**
 * DX-517: texto propio de cada moneda de la clínica. Los importes llevan el
 * código ISO 4217 (DX-378, «1.234,50 VES»); la clínica puede decir con qué
 * texto se escribe una moneda que usa («VES» → «Bs.»). Ese texto ocupa el
 * lugar del código en la posición y con el espacio que da el locale de quien
 * formatea: «Bs. 1.234,50» en `es-VE`, «1.234,50 Bs.» en `de-DE`.
 *
 * Mismo algoritmo y mismos vectores (`currency-text.cases.json`, copia byte a
 * byte en la web) que `src/lib/format/currency-text.ts` de la web, así que la
 * pantalla, el papel y el email dicen lo mismo. Ningún texto por país en el
 * código: sin configurar, el mapa está vacío y nada cambia.
 */

/** Código ISO 4217 (en mayúsculas) → texto con el que la clínica lo escribe. */
export type CurrencyTexts = Readonly<Record<string, string>>;

export const NO_CURRENCY_TEXTS: CurrencyTexts = Object.freeze({});

/** Tope de caracteres del texto de una moneda. */
export const CURRENCY_TEXT_MAX = 8;
/** Tope de monedas con texto propio en una clínica. */
export const CURRENCY_TEXTS_MAX_ENTRIES = 30;

const CURRENCY_CODE_RE = /^[A-Z]{3}$/;
// Controles, formato (marcas de dirección, ZWJ) y separadores de línea.
const NOT_PLAIN_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const BIDI_MARKS_RE = /[\u200e\u200f\u061c]/g;

/** Un código con forma de ISO 4217 (tres letras mayúsculas). */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODE_RE.test(value);
}

/** Un texto de moneda válido: 1..8 caracteres, sin espacios en los extremos ni controles. */
export function isCurrencyText(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    return false;
  }
  return !NOT_PLAIN_RE.test(value) && [...value].length <= CURRENCY_TEXT_MAX;
}

/**
 * El mapa tal como se lee de la BD o de una foto: solo las entradas válidas
 * (lo demás se ignora; nunca lanza). Vacío si no es un objeto.
 */
export function readCurrencyTexts(value: unknown): CurrencyTexts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return NO_CURRENCY_TEXTS;
  }
  const out: Record<string, string> = {};
  for (const [code, text] of Object.entries(value as Record<string, unknown>)) {
    if (isCurrencyCode(code) && isCurrencyText(text)) out[code] = text;
  }
  return Object.keys(out).length > 0 ? out : NO_CURRENCY_TEXTS;
}

/** El texto propio de `currency`, o `undefined` si la clínica no puso ninguno. */
export function currencyTextFor(
  texts: CurrencyTexts | null | undefined,
  currency: string,
): string | undefined {
  if (!texts) return undefined;
  const text = texts[currency.toUpperCase()];
  return isCurrencyText(text) ? text : undefined;
}

/** 0 decimales si la moneda no tiene unidad menor (CLDR 47) y el importe es entero; si no, 2. */
export function moneyDigits(amount: number, currency: string): number {
  return CLDR_ZERO_FORMAT_DIGITS.has(currency.toUpperCase()) &&
    Number.isInteger(amount)
    ? 0
    : 2;
}

const codeFormatters = new Map<string, Intl.NumberFormat>();

/**
 * El importe con el formato de `locale` y el código de la moneda sustituido
 * por `text`: se formatea con `currencyDisplay: 'code'` y se cambia SOLO la
 * parte `currency`, así que el orden, el signo y el espacio son los del
 * locale. Dígitos latinos y sin marcas de dirección. Un código que `Intl` no
 * acepta (mal formado) pone el texto delante de la cifra.
 */
export function moneyWithCurrencyText(
  amount: number,
  currency: string,
  locale: string,
  text: string,
): string {
  const digits = moneyDigits(amount, currency);
  const key = `${locale}|${currency}|${digits}`;
  let formatter = codeFormatters.get(key);
  try {
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'code',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        numberingSystem: 'latn',
      });
      codeFormatters.set(key, formatter);
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const number = new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      numberingSystem: 'latn',
    }).format(amount);
    return `${text} ${number}`.replace(BIDI_MARKS_RE, '');
  }
  return formatter
    .formatToParts(amount)
    .map((part) => (part.type === 'currency' ? text : part.value))
    .join('')
    .replace(BIDI_MARKS_RE, '');
}
