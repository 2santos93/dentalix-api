import type { PatientImportFileFormat } from '@prisma/client';
import { parseCsv, type CsvDelimiter, type CsvEncoding } from './csv-parser';
import { ImportFileError, buildTable, type ParsedTable } from './tabular-file';
import { looksLikeOle, looksLikeZip, readXlsx } from './xlsx-reader';

export const UNSUPPORTED_EXTENSION_MESSAGE =
  'Sube un archivo .csv o .xlsx (Excel). Otros formatos no se pueden importar.';
export const LEGACY_XLS_MESSAGE =
  'Es un Excel antiguo (.xls) o protegido con contraseña. Guárdalo como .xlsx sin contraseña o como CSV y vuelve a subirlo.';
export const EXTENSION_MISMATCH_MESSAGE =
  'El contenido del archivo no coincide con su extensión: guárdalo de nuevo como .csv o .xlsx.';
export const EMPTY_FILE_MESSAGE = 'El archivo está vacío.';
export const NO_ROWS_MESSAGE =
  'El archivo solo tiene la cabecera: no hay pacientes que importar.';

export interface ImportFile {
  format: PatientImportFileFormat;
  table: ParsedTable;
  /** Solo CSV: codificación y separador detectados. */
  encoding?: CsvEncoding;
  delimiter?: CsvDelimiter;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export const UNREADABLE_MESSAGE =
  'No se pudo leer el archivo. Ábrelo en Excel y guárdalo de nuevo como «CSV UTF-8» o .xlsx.';

/**
 * Lee un fichero de pacientes. El FORMATO lo decide el contenido (un ZIP es
 * .xlsx; un OLE2, .xls antiguo; lo demás se trata como texto CSV) y tiene que
 * cuadrar con la extensión. Asíncrono: descomprime en segundo plano y cede
 * el hilo cada 500 registros, así un fichero grande no para la API. Lanza
 * SIEMPRE `ImportFileError` (400 en español) si el fichero no sirve: un fallo
 * inesperado del lector también (nunca un 500 por un fichero raro).
 */
export async function readImportFile(
  bytes: Buffer,
  originalName: string,
): Promise<ImportFile> {
  try {
    return await read(bytes, originalName);
  } catch (err) {
    if (err instanceof ImportFileError) throw err;
    throw new ImportFileError(UNREADABLE_MESSAGE, { cause: err });
  }
}

async function read(bytes: Buffer, originalName: string): Promise<ImportFile> {
  const ext = extensionOf(originalName);
  if (!['csv', 'txt', 'xlsx', 'xls'].includes(ext)) {
    throw new ImportFileError(UNSUPPORTED_EXTENSION_MESSAGE);
  }
  if (bytes.length === 0) throw new ImportFileError(EMPTY_FILE_MESSAGE);
  if (looksLikeOle(bytes)) throw new ImportFileError(LEGACY_XLS_MESSAGE);
  if (ext === 'xls') throw new ImportFileError(LEGACY_XLS_MESSAGE);
  const zip = looksLikeZip(bytes);
  if (zip !== (ext === 'xlsx')) {
    throw new ImportFileError(EXTENSION_MISMATCH_MESSAGE);
  }
  if (zip) {
    const table = await buildTable(await readXlsx(bytes));
    if (table.rows.length === 0) throw new ImportFileError(NO_ROWS_MESSAGE);
    return { format: 'XLSX', table };
  }
  const csv = parseCsv(bytes);
  const table = await buildTable(csv.records);
  if (table.rows.length === 0) throw new ImportFileError(NO_ROWS_MESSAGE);
  return {
    format: 'CSV',
    table,
    encoding: csv.encoding,
    delimiter: csv.delimiter,
  };
}
