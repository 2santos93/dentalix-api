import { ImportFileError, type TableRow } from './tabular-file';

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
 * coincide con Latin-1. A mano porque el TextDecoder de Node sin ICU completo
 * trata «windows-1252» como Latin-1 y deja ahí caracteres de control.
 */
const CP1252_HIGH =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
  '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

export function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out +=
      byte >= 0x80 && byte <= 0x9f
        ? CP1252_HIGH[byte - 0x80]
        : String.fromCharCode(byte);
  }
  return out;
}

/**
 * Separador: el que más aparece FUERA de comillas en la primera línea
 * (la cabecera). Excel en español (es-CO, es-ES) guarda con «;» porque la
 * coma es el decimal; en inglés, con «,». Empate o ninguno: «,».
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
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
 * RFC 4180: campos entre comillas con "" como comilla escapada y saltos de
 * línea dentro; fin de línea CRLF, LF o CR. Una comilla suelta dentro de un
 * campo sin comillas se toma literal (lo que hace Excel).
 */
export function parseCsvRecords(
  text: string,
  delimiter: CsvDelimiter,
): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export interface ParsedCsv {
  /** Registros con su número de fila (el que muestra Excel al abrirlo). */
  records: TableRow[];
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
  const offset = hint ? 2 : 1;
  const records = parseCsvRecords(text, delimiter).map((cells, i) => ({
    rowNumber: i + offset,
    cells,
  }));
  return { records, encoding, delimiter };
}
