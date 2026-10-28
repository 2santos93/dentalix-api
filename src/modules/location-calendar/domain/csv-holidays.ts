import { parseCsv } from '../../patient-imports/domain/csv-parser';
import { ImportFileError } from '../../patient-imports/domain/tabular-file';
import type {
  HolidayCandidate,
  HolidayRowError,
  ParsedHolidayFile,
} from './holiday-file';
import {
  HOLIDAY_MESSAGES,
  HolidayRuleError,
  MAX_HOLIDAYS_PER_FILE,
  assertRecurringAllowed,
  validateHolidayDate,
  validateHolidayName,
} from './holiday-rules';

/**
 * Lector CSV de festivos (spec §5.2), puro. Decodifica y separa con el lector
 * de la importación de pacientes (P15: BOM, Windows-1252, `;` o `,`, comillas
 * RFC 4180, CRLF). La cabecera va en la primera fila; las fechas solo en ISO
 * (R8): `03/05/2027` o un número de serie de Excel son errores de fila.
 */

type Column = 'date' | 'name' | 'recurring';

/** Nombres de columna ya normalizados (minúsculas, sin acentos, recortados). */
const HEADER_ALIASES: Record<string, Column> = {
  fecha: 'date',
  date: 'date',
  nombre: 'name',
  name: 'name',
  recurrente: 'recurring',
  recurring: 'recurring',
  'cada ano': 'recurring',
};

const YES = new Set(['si', 'yes', 'true', '1', 'x']);
const NO = new Set(['', 'no', 'false', '0']);

function normalizeLabel(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function isBlank(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}

export function parseCsvHolidays(bytes: Buffer): ParsedHolidayFile {
  const { records } = parseCsv(bytes);
  const first = records.next();
  if (first.done) throw new ImportFileError(HOLIDAY_MESSAGES.emptyFile);

  // Cada columna, la primera de la cabecera con ese nombre o alias.
  const columns = new Map<Column, number>();
  first.value.cells.forEach((cell, index) => {
    const column = HEADER_ALIASES[normalizeLabel(cell)];
    if (column && !columns.has(column)) columns.set(column, index);
  });
  const dateAt = columns.get('date');
  const nameAt = columns.get('name');
  const recurringAt = columns.get('recurring');
  if (dateAt === undefined || nameAt === undefined) {
    if (isBlank(first.value.cells) && allBlank(records)) {
      throw new ImportFileError(HOLIDAY_MESSAGES.emptyFile);
    }
    throw new ImportFileError(HOLIDAY_MESSAGES.csvHeader);
  }

  const candidates: HolidayCandidate[] = [];
  const errors: HolidayRowError[] = [];
  for (const record of records) {
    if (isBlank(record.cells)) continue;
    // La entrada 501 corta la lectura: el resto del fichero no se recorre.
    if (candidates.length + errors.length === MAX_HOLIDAYS_PER_FILE) {
      throw new ImportFileError(HOLIDAY_MESSAGES.tooManyEntries);
    }
    const cell = (index: number | undefined) =>
      index === undefined ? '' : (record.cells[index] ?? '');
    const line = record.rowNumber;
    const read = readRow(
      cell(dateAt),
      cell(nameAt),
      recurringAt === undefined ? '' : cell(recurringAt),
    );
    if ('message' in read) errors.push({ line, ...read });
    else candidates.push({ line, ...read });
  }
  return { format: 'CSV', candidates, errors };
}

/** Los registros que quedan están todos en blanco (el fichero solo tiene saltos). */
function allBlank(records: Iterator<{ cells: string[] }>): boolean {
  for (let next = records.next(); !next.done; next = records.next()) {
    if (!isBlank(next.value.cells)) return false;
  }
  return true;
}

type ReadRow = Omit<HolidayCandidate, 'line'> | Omit<HolidayRowError, 'line'>;

/**
 * Una fila, con un único mensaje: el primero de fecha, nombre, recurrente y
 * 29 de febrero. Lo que sí se pudo leer va en el error.
 */
function readRow(
  rawDate: string,
  rawName: string,
  rawRecurring: string,
): ReadRow {
  const date = attempt(() => validateHolidayDate(rawDate));
  const name = attempt(() => validateHolidayName(rawName));
  const flag = normalizeLabel(rawRecurring);
  const recurring = YES.has(flag) ? true : NO.has(flag) ? false : null;

  const failed = (message: string): ReadRow => ({
    date: date.value,
    name: name.value,
    recurring,
    message,
  });
  if (date.error !== null) return failed(date.error);
  if (name.error !== null) return failed(name.error);
  const day = date.value;
  if (day === null || name.value === null) {
    throw new Error('unreachable: a value without an error');
  }
  if (recurring === null) return failed(HOLIDAY_MESSAGES.recurringInvalid);
  const feb29 = attempt(() => assertRecurringAllowed(day, recurring));
  if (feb29.error !== null) return failed(feb29.error);
  return { date: day, name: name.value, recurring };
}

function attempt<T>(fn: () => T): { value: T | null; error: string | null } {
  try {
    return { value: fn(), error: null };
  } catch (error) {
    if (error instanceof HolidayRuleError) {
      return { value: null, error: error.message };
    }
    throw error;
  }
}
