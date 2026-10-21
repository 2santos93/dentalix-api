import { inflateRawSync } from 'node:zlib';
import { ImportFileError, type TableRow } from './tabular-file';

/*
 * Lector mínimo de .xlsx (DX-107): solo lo que hace falta para leer la
 * PRIMERA hoja como texto. Sin dependencias (ver el informe de DX-107):
 *
 * - ZIP: directorio central, entradas «stored» o «deflate». Sin ZIP64 ni
 *   cifrado. Cada entrada se descomprime con tope de salida (zip bomb).
 * - XML: sin DTD ni entidades externas (XXE): solo las 5 entidades
 *   predefinidas, las numéricas y el escape `_xHHHH_` de OOXML.
 * - Celdas: cadenas compartidas, en línea, de fórmula, booleanos y números.
 *   Un número con formato de fecha (estilos) sale como AAAA-MM-DD.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** Tope de cada parte descomprimida (la hoja de 10.000 filas pesa ~5–10 MB). */
export const MAX_XLSX_PART_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 5000;

const NOT_XLSX_MESSAGE =
  'El archivo no es un Excel .xlsx válido. Ábrelo en Excel y guárdalo de nuevo como .xlsx o como CSV.';
const ENCRYPTED_MESSAGE =
  'El Excel está protegido con contraseña. Quita la protección y vuelve a subirlo.';
const TOO_BIG_MESSAGE =
  'La hoja de Excel es demasiado grande una vez descomprimida. Divídela en varios archivos.';

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function readEntries(zip: Buffer): Map<string, ZipEntry> {
  const minEocd = 22;
  if (zip.length < minEocd) throw new ImportFileError(NOT_XLSX_MESSAGE);
  let eocd = -1;
  const stop = Math.max(0, zip.length - (0xffff + minEocd));
  for (let i = zip.length - minEocd; i >= stop; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportFileError(NOT_XLSX_MESSAGE);
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || offset === 0xffffffff) {
    throw new ImportFileError(NOT_XLSX_MESSAGE);
  }
  const entries = new Map<string, ZipEntry>();
  for (let k = 0; k < count; k += 1) {
    if (
      offset + 46 > zip.length ||
      zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    ) {
      throw new ImportFileError(NOT_XLSX_MESSAGE);
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const name = zip
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    entries.set(name, {
      name,
      flags: zip.readUInt16LE(offset + 8),
      method: zip.readUInt16LE(offset + 10),
      compressedSize: zip.readUInt32LE(offset + 20),
      uncompressedSize: zip.readUInt32LE(offset + 24),
      localOffset: zip.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(zip: Buffer, entry: ZipEntry): Buffer {
  if (entry.flags & 0x1) throw new ImportFileError(ENCRYPTED_MESSAGE);
  if (entry.uncompressedSize > MAX_XLSX_PART_BYTES) {
    throw new ImportFileError(TOO_BIG_MESSAGE);
  }
  const at = entry.localOffset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw new ImportFileError(NOT_XLSX_MESSAGE);
  }
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new ImportFileError(NOT_XLSX_MESSAGE);
  const data = zip.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new ImportFileError(NOT_XLSX_MESSAGE);
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_XLSX_PART_BYTES });
  } catch (err) {
    if (
      err instanceof RangeError ||
      (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
    ) {
      throw new ImportFileError(TOO_BIG_MESSAGE);
    }
    throw new ImportFileError(NOT_XLSX_MESSAGE);
  }
}

/** Texto de una parte del paquete, o null si no está. */
function part(
  zip: Buffer,
  entries: Map<string, ZipEntry>,
  name: string,
): string | null {
  const entry = entries.get(name);
  return entry ? readEntry(zip, entry).toString('utf8') : null;
}

/** Entidades XML predefinidas, numéricas y el escape `_xHHHH_` de OOXML. */
export function decodeXmlText(raw: string): string {
  return raw
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, ent: string) => {
      switch (ent.toLowerCase()) {
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'amp':
          return '&';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default: {
          const code =
            ent[1].toLowerCase() === 'x'
              ? parseInt(ent.slice(2), 16)
              : parseInt(ent.slice(1), 10);
          return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
      }
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXmlText(m[1]) : null;
}

/** Texto de los `<t>` de un fragmento (sin la fonética `<rPh>`). */
function runsText(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) {
    out += m[1] ? decodeXmlText(m[1]) : '';
  }
  return out;
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map(
    (m) => (m[1] ? runsText(m[1]) : ''),
  );
}

/** Formatos de número de fecha predefinidos de Excel (ECMA-376 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[dmy]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

/** Por índice de estilo de celda (`s`), si su formato es de fecha. */
function dateStyles(xml: string | null): boolean[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'numFmtId');
    const code = attr(m[1], 'formatCode');
    if (id !== null && code !== null) custom.set(Number(id), code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!xfs) return [];
  return [...xfs[1].matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => {
    const id = Number(attr(m[1], 'numFmtId') ?? '0');
    const code = custom.get(id);
    return code !== undefined
      ? isDateFormatCode(code)
      : BUILTIN_DATE_FORMATS.has(id);
  });
}

/** Serie de Excel (sistema 1900; 1904 si el libro lo dice) → AAAA-MM-DD. */
export function excelSerialToDate(
  serial: number,
  date1904 = false,
): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const days = Math.floor(serial) + (date1904 ? 1462 : 0);
  // Excel cuenta el 29/02/1900 inexistente: desde el 1/03/1900 se resta 1.
  const epoch = Date.UTC(1899, 11, days >= 61 ? 30 : 31);
  const d = new Date(epoch + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Número tal como lo ve la persona en la hoja (sin notación científica). */
function numberText(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n) && Math.abs(n) < Number.MAX_SAFE_INTEGER) {
    return n.toFixed(0);
  }
  return String(n);
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** Ruta de la primera hoja del libro según workbook.xml y sus relaciones. */
function firstSheetPath(workbook: string, rels: string | null): string {
  const sheet = /<sheet\b([^>]*)\/?>/.exec(workbook);
  const relId = sheet ? attr(sheet[1], 'r:id') : null;
  if (rels && relId) {
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      if (attr(m[1], 'Id') !== relId) continue;
      const target = attr(m[1], 'Target') ?? '';
      return target.startsWith('/')
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, '')}`;
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

export interface XlsxSheet {
  records: TableRow[];
}

/** Lee la primera hoja del libro como filas de texto con su número de fila. */
export function readXlsx(bytes: Buffer): XlsxSheet {
  const entries = readEntries(bytes);
  if (entries.has('EncryptionInfo'))
    throw new ImportFileError(ENCRYPTED_MESSAGE);
  const workbook = part(bytes, entries, 'xl/workbook.xml');
  if (!workbook) throw new ImportFileError(NOT_XLSX_MESSAGE);
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const sheetXml = part(
    bytes,
    entries,
    firstSheetPath(
      workbook,
      part(bytes, entries, 'xl/_rels/workbook.xml.rels'),
    ),
  );
  if (!sheetXml) throw new ImportFileError(NOT_XLSX_MESSAGE);
  const strings = sharedStrings(part(bytes, entries, 'xl/sharedStrings.xml'));
  const dates = dateStyles(part(bytes, entries, 'xl/styles.xml'));

  const records: TableRow[] = [];
  let lastRow = 0;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (const row of sheetXml.matchAll(rowRe)) {
    const r = Number(attr(row[1], 'r') ?? lastRow + 1);
    lastRow = r;
    if (!row[2]) continue;
    const cells: string[] = [];
    let lastCol = -1;
    for (const c of row[2].matchAll(cellRe)) {
      const ref = attr(c[1], 'r');
      const col = ref ? columnIndex(ref.replace(/\d+$/, '')) : lastCol + 1;
      lastCol = col;
      if (col < 0 || col > 16_383) continue;
      const body = c[2] ?? '';
      const type = attr(c[1], 't') ?? 'n';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      let text = '';
      if (type === 'inlineStr') text = runsText(body);
      else if (!v) text = '';
      else if (type === 's') text = strings[Number(v[1])] ?? '';
      else if (type === 'b') text = v[1] === '1' ? 'VERDADERO' : 'FALSO';
      else if (type === 'str' || type === 'e') text = decodeXmlText(v[1]);
      else {
        const style = Number(attr(c[1], 's') ?? '0');
        text = dates[style]
          ? (excelSerialToDate(Number(v[1]), date1904) ?? numberText(v[1]))
          : numberText(v[1]);
      }
      while (cells.length < col) cells.push('');
      cells[col] = text;
    }
    records.push({ rowNumber: r, cells });
  }
  return { records };
}

/** ¿Empieza como un ZIP (local file header)? */
export function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_SIGNATURE;
}

/** ¿Es un .xls antiguo (OLE2 / Compound File)? */
export function looksLikeOle(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  );
}
