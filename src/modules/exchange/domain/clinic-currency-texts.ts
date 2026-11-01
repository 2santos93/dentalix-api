import {
  CURRENCY_TEXT_MAX,
  CURRENCY_TEXTS_MAX_ENTRIES,
  isCurrencyText,
  type CurrencyTexts,
} from '../../../shared/format/currency-text';

/**
 * DX-517: el texto propio de cada moneda de la clínica, como lo edita
 * Ajustes › Monedas: una lista de pares código ISO → texto. Vacía = nada
 * configurado (los importes llevan el código ISO, DX-378).
 */
export interface CurrencyTextEntry {
  currency: string;
  text: string;
}

export const CURRENCY_TEXTS_TOO_MANY_MESSAGE = `Puedes dar texto propio a ${CURRENCY_TEXTS_MAX_ENTRIES} monedas como mucho.`;
export const currencyTextUnknownMessage = (code: string): string =>
  `«${code}» no es una moneda del catálogo (código ISO 4217 de tres letras).`;
export const currencyTextInvalidMessage = (code: string): string =>
  `El texto de ${code} admite de 1 a ${CURRENCY_TEXT_MAX} caracteres en una línea.`;
export const currencyTextDuplicateMessage = (code: string): string =>
  `${code} aparece más de una vez.`;

/** Resultado de validar la lista: el mapa a guardar o el primer error, en español. */
export type CurrencyTextsInput =
  { ok: true; texts: CurrencyTexts } | { ok: false; message: string };

/**
 * Valida la lista (sin mirar el catálogo): código en mayúsculas, texto
 * recortado de 1..8 caracteres sin controles, sin repetidos y hasta 30.
 * `isKnownCurrency` dice si el código está en `currencies`.
 */
export function parseCurrencyTextEntries(
  entries: readonly { currency: string; text: string }[],
  isKnownCurrency: (code: string) => boolean,
): CurrencyTextsInput {
  if (entries.length > CURRENCY_TEXTS_MAX_ENTRIES) {
    return { ok: false, message: CURRENCY_TEXTS_TOO_MANY_MESSAGE };
  }
  const texts: Record<string, string> = {};
  for (const entry of entries) {
    const code = entry.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || !isKnownCurrency(code)) {
      return { ok: false, message: currencyTextUnknownMessage(entry.currency) };
    }
    if (code in texts) {
      return { ok: false, message: currencyTextDuplicateMessage(code) };
    }
    const text = entry.text.trim();
    if (!isCurrencyText(text)) {
      return { ok: false, message: currencyTextInvalidMessage(code) };
    }
    texts[code] = text;
  }
  return { ok: true, texts: sortedTexts(texts) };
}

/** El mapa con las claves en orden alfabético (para la BD, la API y la auditoría). */
export function sortedTexts(texts: CurrencyTexts): CurrencyTexts {
  return Object.fromEntries(
    Object.keys(texts)
      .sort()
      .map((code) => [code, texts[code]]),
  );
}

/** La lista de la API, en orden alfabético de código. */
export function currencyTextEntries(texts: CurrencyTexts): CurrencyTextEntry[] {
  return Object.keys(texts)
    .sort()
    .map((currency) => ({ currency, text: texts[currency] }));
}

/** Para el antes y el después de la auditoría: «VES=Bs.», en orden. */
export function currencyTextsForAudit(texts: CurrencyTexts): string[] {
  return currencyTextEntries(texts).map((e) => `${e.currency}=${e.text}`);
}
