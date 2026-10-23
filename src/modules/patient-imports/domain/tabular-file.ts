import { MAX_IMPORT_ROWS, TOO_MANY_ROWS_MESSAGE } from './import-fields';

/**
 * Error del fichero entero (formato, codificación, tamaño, filas): 400 en
 * español, sin lote. Los errores de UNA fila no lo son: van al informe.
 */
export class ImportFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportFileError';
  }
}

export interface TableRow {
  /** Fila del fichero tal como la numera la hoja de cálculo (1 = cabecera). */
  rowNumber: number;
  cells: string[];
  /**
   * La fila trae algo escrito más allá de la última columna de la cabecera
   * (un separador sin comillas dentro de un dato): es un error de la fila.
   */
  extraCells?: boolean;
}

/** Un registro tal como sale del lector (CSV o XLSX), antes de la cabecera. */
export interface RawRecord {
  rowNumber: number;
  /** Como mucho `MAX_COLUMNS` celdas: el lector no guarda más. */
  cells: string[];
  /** Había algo escrito en una columna ≥ `MAX_COLUMNS`. */
  overflow?: boolean;
}

export interface ParsedTable {
  headers: string[];
  /** Solo las filas con algún dato; las vacías se ignoran. */
  rows: TableRow[];
}

/** Columnas como mucho: un fichero de pacientes no tiene más. */
export const MAX_COLUMNS = 100;
/**
 * Filas FÍSICAS (líneas del CSV o `<row>` de la hoja, vacías incluidas) que
 * se recorren como mucho: 10.000 pacientes con holgura para filas en blanco
 * y títulos. Acota el tiempo de un fichero hecho de saltos de línea.
 */
export const MAX_PHYSICAL_ROWS = 50_000;
/** Una celda más larga no cabe en ningún campo: se guarda recortada. */
export const MAX_CELL_CHARS = 5_000;

const NO_HEADER_MESSAGE =
  'El archivo no tiene cabecera: la primera fila con datos debe tener los nombres de las columnas.';
const TOO_MANY_COLUMNS_MESSAGE = `El archivo tiene más de ${MAX_COLUMNS} columnas: revisa que sea la hoja de pacientes.`;
const TOO_MANY_PHYSICAL_MESSAGE = `El archivo tiene más de ${MAX_PHYSICAL_ROWS.toLocaleString('es-CO')} filas (contando las vacías). Quita las filas en blanco o divídelo.`;
const DUPLICATE_HEADER_MESSAGE = (h: string) =>
  `La columna «${h}» aparece dos veces en la cabecera: cambia el nombre de una de ellas.`;

const filled = (cells: readonly string[]) =>
  cells.filter((c) => c !== '').length;

/**
 * Arma la tabla registro a registro, sin guardar nada que no haga falta:
 *
 * - las filas vacías no se guardan (solo cuentan para el tope físico);
 * - la CABECERA es la primera fila con al menos dos celdas escritas: un
 *   título encima («Listado de pacientes», una sola celda) se salta;
 * - topes: columnas de la cabecera, filas físicas y 10.000 filas con datos,
 *   comprobados al añadir (nunca después de haberlo leído todo).
 */
export class TableBuilder {
  private headers: string[] | null = null;
  private readonly rows: TableRow[] = [];
  private physical = 0;

  add(record: RawRecord): void {
    this.physical += 1;
    if (this.physical > MAX_PHYSICAL_ROWS) {
      throw new ImportFileError(TOO_MANY_PHYSICAL_MESSAGE);
    }
    const cells = record.cells.map((c) => c.trim());
    const count = filled(cells);
    if (count === 0 && !record.overflow) return;
    if (!this.headers) {
      if (record.overflow) throw new ImportFileError(TOO_MANY_COLUMNS_MESSAGE);
      if (count < 2) return;
      this.headers = headerOf(cells);
      return;
    }
    const width = this.headers.length;
    const row = cells.slice(0, width);
    while (row.length < width) row.push('');
    const extra =
      Boolean(record.overflow) || cells.slice(width).some((c) => c !== '');
    if (filled(row) === 0 && !extra) return;
    if (this.rows.length >= MAX_IMPORT_ROWS) {
      throw new ImportFileError(TOO_MANY_ROWS_MESSAGE);
    }
    this.rows.push({
      rowNumber: record.rowNumber,
      cells: row,
      ...(extra ? { extraCells: true } : {}),
    });
  }

  finish(): ParsedTable {
    if (!this.headers) throw new ImportFileError(NO_HEADER_MESSAGE);
    return { headers: this.headers, rows: this.rows };
  }
}

function headerOf(cells: string[]): string[] {
  let width = cells.length;
  while (width > 0 && cells[width - 1] === '') width -= 1;
  if (width > MAX_COLUMNS) throw new ImportFileError(TOO_MANY_COLUMNS_MESSAGE);
  const headers = cells.slice(0, width);
  const seen = new Set<string>();
  for (const h of headers) {
    if (h === '') continue;
    const key = h.toLowerCase();
    if (seen.has(key)) throw new ImportFileError(DUPLICATE_HEADER_MESSAGE(h));
    seen.add(key);
  }
  return headers;
}

/** Tabla de una lista ya leída (pruebas y ficheros pequeños). */
export function toTable(records: Iterable<RawRecord>): ParsedTable {
  const builder = new TableBuilder();
  for (const record of records) builder.add(record);
  return builder.finish();
}

/** Cede el hilo: un fichero grande no bloquea al resto de peticiones. */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Cada cuántos registros se cede el hilo al leer o validar. */
export const YIELD_EVERY = 500;

/**
 * Lee los registros de un lector cediendo el hilo cada `YIELD_EVERY`. El
 * lector de XLSX es asíncrono y cede además DENTRO de cada registro.
 */
export async function buildTable(
  records: Iterable<RawRecord> | AsyncIterable<RawRecord>,
): Promise<ParsedTable> {
  const builder = new TableBuilder();
  let n = 0;
  for await (const record of records) {
    builder.add(record);
    n += 1;
    if (n % YIELD_EVERY === 0) await yieldToEventLoop();
  }
  return builder.finish();
}
