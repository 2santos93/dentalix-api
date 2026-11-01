import {
  ImportFileError,
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  type RawRecord,
} from './tabular-file';

export type CsvEncoding = 'utf-8' | 'windows-1252' | 'utf-16le';
export type CsvDelimiter = ',' | ';' | '\t';

export interface DecodedCsv {
  text: string;
  encoding: CsvEncoding;
}

const BINARY_MESSAGE =
  'El archivo no parece un CSV de texto. Guárdalo desde Excel como «CSV UTF-8» o como .xlsx.';

/**
 * Texto del CSV. Excel guarda «CSV UTF-8» con BOM, «CSV (delimitado por
 * comas)» en Windows-1252 (Latin-1 con € y comillas tipográficas) sin BOM y
 * «Texto Unicode» en UTF-16 LE con BOM. Sin BOM se intenta UTF-8 estricto y,
 * si no lo es, Windows-1252 (cualquier byte es válido ahí). Un NUL fuera de
 * UTF-16 es un binario, no un CSV.
 */
export function decodeCsv(bytes: Buffer): DecodedCsv {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
      encoding: 'utf-16le',
    };
  }
  const body =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  if (body.includes(0)) throw new ImportFileError(BINARY_MESSAGE);
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(body),
      encoding: 'utf-8',
    };
  } catch {
    return { text: decodeWindows1252(body), encoding: 'windows-1252' };
  }
}

/**
 * 0x80–0x9F de Windows-1252 (€, comillas tipográficas, guiones…); el resto
 * coincide con Latin-1. El TextDecoder de Node sin ICU completo trata
 * «windows-1252» como Latin-1 y deja ahí caracteres de control, así que se
 * decodifica en NATIVO como `latin1` (lineal, sin concatenar carácter a
 * carácter: revisión 2026-10-23, I1) y solo se corrige ese tramo.
 */
const CP1252_HIGH =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
  '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

const CP1252_HIGH_RANGE = /[\x80-\x9f]/g;

export function decodeWindows1252(bytes: Uint8Array): string {
  const latin1 = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString('latin1');
  return latin1.replace(
    CP1252_HIGH_RANGE,
    (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80],
  );
}

const DELIMITER_SAMPLE_LINES = 20;

/**
 * Separador: el que más aparece FUERA de comillas en las primeras líneas
 * (la cabecera y unas filas). Excel en español (es-*) guarda con «;» porque la
 * coma es el decimal; en inglés, con «,». Empate o ninguno: «,».
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  let lines = 0;
  // Las primeras líneas (por si hay un título encima de la cabecera).
  const sample = text.slice(0, 64 * 1024);
  for (const ch of sample) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '\n' && ++lines >= DELIMITER_SAMPLE_LINES) break;
    else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) {
      counts[ch] += 1;
    }
  }
  const best = (Object.keys(counts) as CsvDelimiter[]).reduce((a, b) =>
    counts[b] > counts[a] ? b : a,
  );
  return counts[best] > 0 ? best : ',';
}

/**
 * RFC 4180, registro a registro (generador): campos entre comillas con ""
 * como comilla escapada y saltos de línea dentro; fin de línea CRLF, LF o CR.
 * Una comilla suelta dentro de un campo sin comillas se toma literal (lo que
 * hace Excel). Lineal, y sin guardar más de lo que hace falta: como mucho
 * `MAX_COLUMNS` campos por registro (más allá solo se anota si había algo
 * escrito) y `MAX_CELL_CHARS` caracteres por campo.
 */
export function* csvRecords(
  text: string,
  delimiter: CsvDelimiter,
  firstRowNumber = 1,
): Generator<RawRecord> {
  let cells: string[] = [];
  let overflow = false;
  let field = '';
  let quoted = false;
  let fieldHasQuotes = false;
  let row = firstRowNumber;
  let pendingRecord = false;
  const n = text.length;
  const pushField = () => {
    if (cells.length < MAX_COLUMNS) cells.push(field);
    else if (field.trim() !== '') overflow = true;
    field = '';
    fieldHasQuotes = false;
  };
  const append = (chunk: string) => {
    if (field.length < MAX_CELL_CHARS) field += chunk;
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          append('"');
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      // Tramo sin comillas de una vez (lineal: indexOf avanza el cursor).
      const next = text.indexOf('"', i);
      const stop = next === -1 ? n : next;
      append(text.slice(i, Math.min(stop, i + MAX_CELL_CHARS)));
      i = stop;
      continue;
    }
    if (ch === '"' && field === '' && !fieldHasQuotes) {
      quoted = true;
      fieldHasQuotes = true;
      pendingRecord = true;
      i += 1;
    } else if (ch === delimiter) {
      pushField();
      pendingRecord = true;
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      pushField();
      yield { rowNumber: row, cells, ...(overflow ? { overflow } : {}) };
      row += 1;
      cells = [];
      overflow = false;
      pendingRecord = false;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      append(ch);
      pendingRecord = true;
      i += 1;
    }
  }
  if (pendingRecord || field !== '') {
    pushField();
    yield { rowNumber: row, cells, ...(overflow ? { overflow } : {}) };
  }
}

/** Todos los registros como listas de campos (pruebas y ficheros pequeños). */
export function parseCsvRecords(
  text: string,
  delimiter: CsvDelimiter,
): string[][] {
  return [...csvRecords(text, delimiter)].map((r) => r.cells);
}

export interface ParsedCsv {
  /** Registros con su número de fila (el que muestra Excel al abrirlo). */
  records: Generator<RawRecord>;
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
}

/** `sep=;` en la primera línea: la pista de separador que entiende Excel. */
const SEP_HINT = /^sep=([,;\t])\r?\n/i;

export function parseCsv(bytes: Buffer): ParsedCsv {
  const { text: decoded, encoding } = decodeCsv(bytes);
  const hint = SEP_HINT.exec(decoded);
  const text = hint ? decoded.slice(hint[0].length) : decoded;
  const delimiter = hint ? (hint[1] as CsvDelimiter) : detectDelimiter(text);
  return {
    records: csvRecords(text, delimiter, hint ? 2 : 1),
    encoding,
    delimiter,
  };
}
