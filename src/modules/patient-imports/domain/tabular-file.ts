import { MAX_IMPORT_ROWS, TOO_MANY_ROWS_MESSAGE } from './import-fields';

/**
 * Error del fichero entero (formato, codificación, tamaño, filas): 400 en
 * español, sin lote. Los errores de UNA fila no lo son: van al informe.
 */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFileError';
  }
}

export interface TableRow {
  /** Fila del fichero tal como la numera la hoja de cálculo (1 = cabecera). */
  rowNumber: number;
  cells: string[];
}

export interface ParsedTable {
  headers: string[];
  /** Solo las filas con algún dato; las vacías se ignoran. */
  rows: TableRow[];
}

/** Columnas como mucho: un fichero de pacientes no tiene más. */
export const MAX_COLUMNS = 100;

const NO_HEADER_MESSAGE =
  'El archivo no tiene cabecera: la primera fila debe tener los nombres de las columnas.';
const TOO_MANY_COLUMNS_MESSAGE = `El archivo tiene más de ${MAX_COLUMNS} columnas: revisa que sea la hoja de pacientes.`;
const DUPLICATE_HEADER_MESSAGE = (h: string) =>
  `La columna «${h}» aparece dos veces en la cabecera: cambia el nombre de una de ellas.`;

/**
 * Cabecera + filas con algo escrito, con su número de fila de la hoja. Comprueba los
 * topes (columnas y 10.000 filas) y que las cabeceras no se repitan.
 */
export function toTable(records: readonly TableRow[]): ParsedTable {
  const trimmed = records.map((r) => ({
    rowNumber: r.rowNumber,
    cells: r.cells.map((c) => c.trim()),
  }));
  const headerIndex = trimmed.findIndex((r) => r.cells.some((c) => c !== ''));
  if (headerIndex < 0) throw new ImportFileError(NO_HEADER_MESSAGE);
  const rawHeaders = trimmed[headerIndex].cells;
  let width = rawHeaders.length;
  while (width > 0 && rawHeaders[width - 1] === '') width -= 1;
  if (width > MAX_COLUMNS) throw new ImportFileError(TOO_MANY_COLUMNS_MESSAGE);
  const headers = rawHeaders.slice(0, width);
  const seen = new Set<string>();
  for (const h of headers) {
    if (h === '') continue;
    const key = h.toLowerCase();
    if (seen.has(key)) throw new ImportFileError(DUPLICATE_HEADER_MESSAGE(h));
    seen.add(key);
  }
  const rows: TableRow[] = [];
  for (let i = headerIndex + 1; i < trimmed.length; i += 1) {
    const cells = trimmed[i].cells.slice(0, width);
    if (!cells.some((c) => c !== '')) continue;
    if (rows.length >= MAX_IMPORT_ROWS) {
      throw new ImportFileError(TOO_MANY_ROWS_MESSAGE);
    }
    while (cells.length < width) cells.push('');
    rows.push({ rowNumber: trimmed[i].rowNumber, cells });
  }
  return { headers, rows };
}
