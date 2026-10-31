/*
 * Celdas de los CSV de exportación (descuentos y gastos): texto entre
 * comillas, sin saltos de línea, y con el prefijo «'» cuando empieza (tras
 * blancos) por = + - @ (o tabulador/CR) para que la hoja de cálculo no lo
 * ejecute como fórmula (inyección CSV).
 */
const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

export function csvText(value: string | null): string {
  const raw = (value ?? '').replace(/[\r\n]+/g, ' ');
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Importe con los decimales de su moneda (JPY sin decimales, EUR a céntimos). */
export function csvAmount(value: number, decimals: 0 | 2): string {
  return value.toFixed(decimals);
}

export const CSV_BOM = '\uFEFF';

/** UTF-8 con BOM y CRLF, como el resto de exportaciones. */
export function csvDocument(lines: readonly string[]): string {
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
