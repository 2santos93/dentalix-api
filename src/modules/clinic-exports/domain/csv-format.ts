import { Prisma } from '@prisma/client';
import { CLDR_ZERO_FORMAT_DIGITS } from '../../../shared/format/cldr-format-digits';
import { csvText } from '../../../shared/csv/csv-cells';
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
 * Importe con los decimales de la pantalla (DX-488, como `csvAmount`) pero
 * EXACTO: llega como texto de NUMERIC y nunca pasa por coma flotante.
 */
export function exactAmount(value: string, currency: string | null): string {
  const decimal = new Prisma.Decimal(value);
  const zero =
    currency !== null &&
    CLDR_ZERO_FORMAT_DIGITS.has(currency.trim().toUpperCase()) &&
    decimal.isInteger();
  return decimal.toFixed(zero ? 0 : 2);
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (!zoneFormatters.has(zone)) {
    let formatter: Intl.DateTimeFormat | null = null;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'longOffset',
      });
    } catch {
      // Zona inválida (no debería: la sede la valida): se escribe en UTC.
      formatter = null;
    }
    zoneFormatters.set(zone, formatter);
  }
  return zoneFormatters.get(zone) ?? null;
}

/**
 * Instante ISO 8601 a segundos: en la zona de la sede con su desfase
 * (`2026-11-21T09:30:00-04:00`) o, sin zona, en UTC (`…Z`).
 * `isoUtc` llega como `AAAA-MM-DDTHH:MM:SS.mmmZ` (ver `pageQuery`).
 */
export function zonedInstant(isoUtc: string, zone: string | null): string {
  const utc = `${isoUtc.slice(0, 19)}Z`;
  const formatter = zone ? formatterFor(zone) : null;
  if (!formatter) return utc;
  const parts: Record<string, string> = {};
  for (const p of formatter.formatToParts(new Date(isoUtc))) {
    parts[p.type] = p.value;
  }
  // «GMT-04:00», «GMT+05:30» o «GMT» (UTC).
  const offset = parts.timeZoneName.replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

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
      return exactAmount(
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
