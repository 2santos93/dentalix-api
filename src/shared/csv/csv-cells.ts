/*
 * Celdas de los CSV de exportación: texto entre
 * comillas, sin saltos de línea, y con el prefijo «'» cuando empieza (tras
 * blancos) por = + - @ (o tabulador/CR) para que la hoja de cálculo no lo
 * ejecute como fórmula (inyección CSV).
 */

import { CLDR_ZERO_FORMAT_DIGITS } from '../format/cldr-format-digits';
import { amountText } from '../money/money';
const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

export function csvText(value: string | null): string {
  const raw = (value ?? '').replace(/[\r\n]+/g, ' ');
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Un importe con los decimales de la PANTALLA (DX-488; `moneyWithCode` de la
 * web): 0 solo si el importe es entero y su moneda se pinta sin decimales
 * (`CLDR_ZERO_FORMAT_DIGITS`); si no, 2 (JPY 1000 → «1000», JPY 1000.50 →
 * «1000.50», USD 1000 → «1000.00»). Nunca con `roundingDigits`: ese es el
 * redondeo de descuentos y convenios, y aquí se comería céntimos guardados.
 * El único formato de importes de los CSV.
 */
export function csvAmount(value: number, currency: string): string {
  const zero =
    CLDR_ZERO_FORMAT_DIGITS.has(currency.toUpperCase()) &&
    Number.isInteger(value);
  return amountText(value, zero ? 0 : 2);
}

export const CSV_BOM = '\uFEFF';

/** UTF-8 con BOM y CRLF, como el resto de exportaciones. */
export function csvDocument(lines: readonly string[]): string {
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
