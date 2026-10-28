import {
  csvRecords,
  decodeCsv,
  detectDelimiter,
  type CsvDelimiter,
} from '../../patient-imports/domain/csv-parser';
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
 * Lector CSV de festivos (spec §5.2), puro. Decodifica y separa con las piezas
 * del lector de la importación de pacientes (P15: BOM, Windows-1252, comillas
 * RFC 4180, CRLF), pero el separador sale de la CABECERA, no de las filas:
 * un nombre con comas («Cierre, anual») no convierte un fichero con `;` en
 * uno con `,` (revisión m2). La cabecera va en la primera fila; las fechas
 * solo en ISO (R8): `03/05/2027` o un número de serie de Excel son errores de
 * fila.
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

/**
 * Minúsculas, sin acentos ni caracteres invisibles (ancho cero, BOM) y con los
 * blancos colapsados y recortados: «  Cada\u00A0 Año » → «cada ano» (m4).
 */
function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `sep=;` en la primera línea: la pista de separador que entiende Excel. */
const SEP_HINT = /^sep=([,;\t])\r?\n/i;
const DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t'];

interface HeaderColumns {
  date: number | undefined;
  name: number | undefined;
  recurring: number | undefined;
}

/** Cada columna, la primera de la cabecera con ese nombre o alias. */
function headerColumns(cells: readonly string[]): HeaderColumns {
  const columns = new Map<Column, number>();
  cells.forEach((cell, index) => {
    const column = HEADER_ALIASES[normalizeLabel(cell)];
    if (column && !columns.has(column)) columns.set(column, index);
  });
  return {
    date: columns.get('date'),
    name: columns.get('name'),
    recurring: columns.get('recurring'),
  };
}

function recognized(columns: HeaderColumns): number {
  return Object.values(columns).filter((at) => at !== undefined).length;
}

/**
 * El separador con el que la primera fila tiene «fecha» y «nombre»; entre
 * varios, el que reconoce más columnas (así `fecha,nombre;recurrente` no
 * pierde «recurrente» en silencio) y, a igualdad, el que más aparece en la
 * cabecera. Con la pista `sep=`, solo ese. Si ninguno, `null`: error de
 * cabecera.
 */
function pickDelimiter(
  text: string,
  hinted: CsvDelimiter | null,
  firstRowNumber: number,
): { delimiter: CsvDelimiter; columns: HeaderColumns } | null {
  const headerLine = text.split(/\r\n|\r|\n/, 1)[0];
  const preferred = detectDelimiter(headerLine);
  const order = hinted
    ? [hinted]
    : [preferred, ...DELIMITERS.filter((d) => d !== preferred)];
  let best: { delimiter: CsvDelimiter; columns: HeaderColumns } | null = null;
  for (const delimiter of order) {
    const header = csvRecords(text, delimiter, firstRowNumber).next();
    if (header.done) return null;
    const columns = headerColumns(header.value.cells);
    if (columns.date === undefined || columns.name === undefined) continue;
    if (best === null || recognized(columns) > recognized(best.columns)) {
      best = { delimiter, columns };
    }
  }
  return best;
}

function isBlank(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}

export function parseCsvHolidays(bytes: Buffer): ParsedHolidayFile {
  const { text: decoded } = decodeCsv(bytes);
  const hint = SEP_HINT.exec(decoded);
  const text = hint ? decoded.slice(hint[0].length) : decoded;
  const firstRowNumber = hint ? 2 : 1;
  if (text.trim() === '') throw new ImportFileError(HOLIDAY_MESSAGES.emptyFile);

  const picked = pickDelimiter(
    text,
    hint ? (hint[1] as CsvDelimiter) : null,
    firstRowNumber,
  );
  if (picked === null) throw new ImportFileError(HOLIDAY_MESSAGES.csvHeader);
  const { delimiter, columns } = picked;

  const records = csvRecords(text, delimiter, firstRowNumber);
  records.next(); // la cabecera
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
      cell(columns.date),
      cell(columns.name),
      cell(columns.recurring),
    );
    if ('message' in read) errors.push({ line, ...read });
    else candidates.push({ line, ...read });
  }
  // Solo la cabecera (o filas en blanco): nada que importar (revisión m1).
  if (candidates.length + errors.length === 0) {
    throw new ImportFileError(HOLIDAY_MESSAGES.emptyFile);
  }
  return { format: 'CSV', candidates, errors };
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
