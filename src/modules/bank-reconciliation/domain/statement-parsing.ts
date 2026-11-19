import { createHash } from 'node:crypto';
import { normalizeReference } from '../../payment-methods/domain/payment-method-rules';
import type { ParsedTable } from '../../patient-imports/domain/tabular-file';
import type {
  DateOrder,
  DecimalSeparator,
  StatementColumnMapping,
} from './statement-mapping';

/**
 * DX-571: de la tabla leída del extracto a movimientos de ENTRADA. Datos de
 * terceros: de cada fila se queda SOLO la fecha, la referencia, el importe y
 * la descripción truncada; el resto de columnas no sale de aquí.
 */

/** Tope de la referencia: el mismo del abono (REFERENCE_MAX, DX-377). */
export const MOVEMENT_REFERENCE_MAX = 60;
/** Descripción truncada (datos de terceros). */
export const MOVEMENT_DESCRIPTION_MAX = 140;
/** Decimal(14,2): menos de 10^12. */
const MAX_AMOUNT_CENTS = 99_999_999_999_999;
/** Incidencias que se devuelven como mucho (como el informe de DX-107). */
export const MAX_REPORTED_ISSUES = 200;

export type StatementIssueCode =
  'DATE_INVALID' | 'AMOUNT_INVALID' | 'REFERENCE_TOO_LONG' | 'EXTRA_CELLS';

export interface StatementIssue {
  rowNumber: number;
  code: StatementIssueCode;
  message: string;
}

export interface ParsedMovement {
  rowNumber: number;
  bookedOn: string;
  reference: string | null;
  referenceNormalized: string | null;
  amountCents: number;
  description: string | null;
}

export interface ParsedStatement {
  /** Filas con datos del fichero. */
  totalRows: number;
  /** Entradas válidas, en el orden del fichero. */
  credits: ParsedMovement[];
  /** Salidas o importes en cero: no se guardan. */
  ignoredRows: number;
  /** Filas con error (no se importan); `issues` trae las primeras 200. */
  errorRows: number;
  issues: StatementIssue[];
}

/** «AAAA-MM-DD» de un día real entre 2000 y 2100, o null. */
function isoDay(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * La fecha de una celda. AAAA-MM-DD (como sale una celda de fecha del .xlsx)
 * vale siempre; si no, tres números separados por «/», «-» o «.» en el orden
 * elegido, con año de 2 o 4 cifras. Una hora detrás se ignora.
 */
export function parseBookedOn(text: string, order: DateOrder): string | null {
  const raw = text.trim().split(/[T\s]/)[0] ?? '';
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) return isoDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const parts = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/.exec(raw);
  if (!parts) return null;
  const [a, b, c] = [parts[1], parts[2], parts[3]];
  const [ys, ms, ds] =
    order === 'YMD' ? [a, b, c] : order === 'MDY' ? [c, a, b] : [c, b, a];
  if (ys.length !== 2 && ys.length !== 4) return null;
  if (ms.length > 2 || ds.length > 2) return null;
  const y = ys.length === 2 ? 2000 + Number(ys) : Number(ys);
  return isoDay(y, Number(ms), Number(ds));
}

/**
 * Céntimos con signo de un importe tal como lo escribe el banco: separador de
 * miles libre, decimal el elegido, signo delante o detrás, entre paréntesis
 * = negativo, y letras de moneda alrededor («Bs.», «USD», «$»). `xlsx`: una
 * celda numérica del .xlsx llega ya como «1234.5» y se lee con punto. Null si
 * no es un importe o tiene más de 2 decimales.
 */
export function parseAmountCents(
  text: string,
  separator: DecimalSeparator,
  xlsx = false,
): number | null {
  let s = text.trim();
  if (s === '') return null;
  if (xlsx && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const cents = Math.round(n * 100);
    // Un .xlsx guarda dobles: 1234.56 puede venir como 1234.5600000001.
    if (Math.abs(n * 100 - cents) > 1e-6 * Math.max(1, Math.abs(n)))
      return null;
    return Math.abs(cents) > MAX_AMOUNT_CENTS ? null : cents;
  }
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // Letras y símbolos de moneda alrededor del número.
  s = s
    .replace(/^[^\d+-]+/u, '')
    .replace(/[^\d-]+$/u, '')
    .trim();
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  s = s.replace(/[\s\u00a0\u202f']/g, '');
  const thousands = separator === ',' ? '.' : ',';
  const pattern =
    separator === ','
      ? /^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/
      : /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;
  if (!pattern.test(s)) return null;
  const [whole, frac = ''] = s.split(separator);
  const units = Number(whole.split(thousands).join(''));
  const cents = units * 100 + Number(frac.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) return null;
  return negative ? -cents : cents;
}

/** Descripción sin controles ni espacios repetidos, truncada a 140. */
export function truncateDescription(text: string | undefined): string | null {
  if (text === undefined) return null;
  const clean = text
    // eslint-disable-next-line no-control-regex -- quitar controles es justo lo que se quiere
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return null;
  const chars = [...clean];
  return chars.length <= MOVEMENT_DESCRIPTION_MAX
    ? clean
    : chars.slice(0, MOVEMENT_DESCRIPTION_MAX).join('').trimEnd();
}

const MESSAGES: Record<StatementIssueCode, string> = {
  DATE_INVALID: 'La fecha no se entiende con el orden elegido.',
  AMOUNT_INVALID: 'El importe no es un número con 2 decimales como mucho.',
  REFERENCE_TOO_LONG: `La referencia tiene más de ${MOVEMENT_REFERENCE_MAX} caracteres.`,
  EXTRA_CELLS:
    'La fila trae más columnas que la cabecera (¿un separador dentro de un dato?).',
};

/** Las entradas del extracto, las salidas ignoradas y las filas con error. */
export function parseStatement(
  table: ParsedTable,
  mapping: StatementColumnMapping,
  format: 'CSV' | 'XLSX',
): ParsedStatement {
  const index = (header: string | undefined): number =>
    header === undefined ? -1 : table.headers.indexOf(header);
  const col = {
    date: index(mapping.date),
    reference: index(mapping.reference),
    amount: index(mapping.amount),
    credit: index(mapping.credit),
    debit: index(mapping.debit),
    description: index(mapping.description),
  };
  const cell = (cells: string[], i: number): string =>
    i < 0 ? '' : (cells[i] ?? '').trim();
  const xlsx = format === 'XLSX';
  const out: ParsedStatement = {
    totalRows: table.rows.length,
    credits: [],
    ignoredRows: 0,
    errorRows: 0,
    issues: [],
  };
  const fail = (rowNumber: number, code: StatementIssueCode) => {
    out.errorRows += 1;
    if (out.issues.length < MAX_REPORTED_ISSUES) {
      out.issues.push({ rowNumber, code, message: MESSAGES[code] });
    }
  };
  for (const row of table.rows) {
    if (row.extraCells) {
      fail(row.rowNumber, 'EXTRA_CELLS');
      continue;
    }
    // El importe primero: una salida se ignora aunque su fecha o su
    // referencia no se entiendan (no se va a guardar).
    let cents: number | null;
    if (col.amount >= 0) {
      const text = cell(row.cells, col.amount);
      cents =
        text === ''
          ? 0
          : parseAmountCents(text, mapping.decimalSeparator, xlsx);
    } else {
      const creditText = cell(row.cells, col.credit);
      const debitText = cell(row.cells, col.debit);
      if (creditText !== '') {
        const credit = parseAmountCents(
          creditText,
          mapping.decimalSeparator,
          xlsx,
        );
        // Una columna de créditos con un número negativo es una salida.
        cents = credit;
        if (credit !== null && credit === 0 && debitText !== '') {
          const debit = parseAmountCents(
            debitText,
            mapping.decimalSeparator,
            xlsx,
          );
          cents = debit === null ? null : -Math.abs(debit);
        }
      } else if (debitText !== '') {
        const debit = parseAmountCents(
          debitText,
          mapping.decimalSeparator,
          xlsx,
        );
        cents = debit === null ? null : -Math.abs(debit);
      } else {
        cents = 0;
      }
    }
    if (cents === null) {
      fail(row.rowNumber, 'AMOUNT_INVALID');
      continue;
    }
    if (cents <= 0) {
      out.ignoredRows += 1;
      continue;
    }
    const bookedOn = parseBookedOn(
      cell(row.cells, col.date),
      mapping.dateOrder,
    );
    if (!bookedOn) {
      fail(row.rowNumber, 'DATE_INVALID');
      continue;
    }
    const referenceText = cell(row.cells, col.reference);
    const referenceNormalized = normalizeReference(referenceText);
    if (
      referenceText.length > MOVEMENT_REFERENCE_MAX ||
      (referenceNormalized?.length ?? 0) > MOVEMENT_REFERENCE_MAX
    ) {
      fail(row.rowNumber, 'REFERENCE_TOO_LONG');
      continue;
    }
    out.credits.push({
      rowNumber: row.rowNumber,
      bookedOn,
      reference: referenceNormalized === null ? null : referenceText,
      referenceNormalized,
      amountCents: cents,
      description: truncateDescription(
        col.description >= 0 ? row.cells[col.description] : undefined,
      ),
    });
  }
  return out;
}

export interface KeyedMovement extends ParsedMovement {
  ordinal: number;
  naturalKey: string;
}

/**
 * Clave natural de cada entrada: sha256(fecha | referencia normalizada |
 * céntimos | ordinal), donde el ordinal es la ocurrencia nº k de esa misma
 * terna en el fichero. El mismo extracto (o uno que lo solapa) da las mismas
 * claves; dos movimientos idénticos legítimos, claves distintas.
 */
export function withNaturalKeys(
  credits: readonly ParsedMovement[],
): KeyedMovement[] {
  const seen = new Map<string, number>();
  return credits.map((m) => {
    const tuple = `${m.bookedOn}|${m.referenceNormalized ?? ''}|${m.amountCents}`;
    const ordinal = (seen.get(tuple) ?? 0) + 1;
    seen.set(tuple, ordinal);
    return {
      ...m,
      ordinal,
      naturalKey: createHash('sha256')
        .update(`${tuple}|${ordinal}`)
        .digest('hex'),
    };
  });
}

/** El primer y el último día de las entradas, o null si no hay ninguna. */
export function periodOf(
  credits: readonly { bookedOn: string }[],
): { from: string; to: string } | null {
  if (credits.length === 0) return null;
  let from = credits[0].bookedOn;
  let to = from;
  for (const { bookedOn } of credits) {
    if (bookedOn < from) from = bookedOn;
    if (bookedOn > to) to = bookedOn;
  }
  return { from, to };
}
