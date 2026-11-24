import { csvDecimalAmount, csvText } from '../../../shared/csv/csv-cells';
import { zonedIsoInstant } from '../../../shared/format/zoned-iso-instant';

/** Instante de la fila: ISO 8601 con el desfase de la sede (ver zonedIsoInstant). */
export const zonedInstant = zonedIsoInstant;
import type { ExportColumn } from './export-catalog';

/**
 * DX-053: celdas de los CSV de la exportación. Mismo formato que el resto de
 * exportaciones (receivables-csv.ts): texto entre comillas y sin fórmulas
 * (`csvText`), números sin comillas con punto decimal, «Sí»/«No», y vacío
 * para lo que no hay.
 */

/** Una fila tal como la devuelve `pageQuery`: `z` zona, `cN` valor, `mN` moneda. */
export type ExportRow = Record<string, unknown>;

const YES = 'Sí';
const NO = 'No';

/**
 * El valor tal como llega de `pageQuery` (texto, salvo booleanos y listas);
 * cualquier otra cosa se escribe como JSON, nunca como «[object Object]».
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value);
}

function cell(
  column: ExportColumn,
  value: unknown,
  currency: unknown,
  zone: string | null,
): string {
  if (value === null || value === undefined) return '';
  switch (column.kind) {
    case 'text':
    case 'json':
      return csvText(asText(value));
    case 'int':
    case 'decimal':
    case 'date':
      return asText(value);
    case 'amount':
      return csvDecimalAmount(
        asText(value),
        typeof currency === 'string' ? currency : null,
      );
    case 'bool':
      return value === true ? YES : NO;
    case 'instant':
      return zonedInstant(asText(value), zone);
    case 'list':
      return Array.isArray(value)
        ? csvText(
            value
              .filter((v) => v !== null && v !== undefined)
              .map(asText)
              .join(' | '),
          )
        : csvText(asText(value));
  }
}

/** La línea CSV de una fila (sin el salto). */
export function csvLine(
  columns: readonly ExportColumn[],
  row: ExportRow,
): string {
  const zone = typeof row.z === 'string' && row.z.length > 0 ? row.z : null;
  return columns
    .map((c, i) => cell(c, row[`c${i}`], row[`m${i}`], zone))
    .join(',');
}

/** Cabecera del CSV. */
export function csvHeader(columns: readonly ExportColumn[]): string {
  return columns.map((c) => csvText(c.header)).join(',');
}
