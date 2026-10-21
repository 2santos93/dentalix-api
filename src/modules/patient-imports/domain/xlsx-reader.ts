import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import {
  ImportFileError,
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  type RawRecord,
} from './tabular-file';

/*
 * Lector mínimo de .xlsx (DX-107): solo lo que hace falta para leer la
 * PRIMERA hoja como texto. Sin dependencias (ver el informe de DX-107):
 *
 * - ZIP: directorio central, entradas «stored» o «deflate». Sin ZIP64 ni
 *   cifrado. Se descomprime en segundo plano (zlib asíncrono) con un tope
 *   TOTAL entre todas las partes (zip bomb), mienta o no la cabecera.
 * - XML: escáner LINEAL con cursor (indexOf), nunca expresiones regulares
 *   sobre la hoja entera: una etiqueta sin cerrar es un error del fichero,
 *   no un recorrido cuadrático. Sin DTD ni entidades externas (XXE): solo
 *   las 5 predefinidas, las numéricas y el escape `_xHHHH_` de OOXML.
 *   Admite prefijos de espacio de nombres (`<x:row>`) y atributos con
 *   comillas simples o dobles.
 * - Celdas: cadenas compartidas, en línea, de fórmula, booleanos y números;
 *   las de error (`t="e"`, #N/A) salen vacías. Un número con formato de
 *   fecha (estilos) sale como AAAA-MM-DD. Columnas ≥ 100 no se guardan.
 */

const inflateRawAsync = promisify(inflateRaw);

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/**
 * Tope de lo descomprimido ENTRE TODAS las partes que se leen: una hoja de
 * 10.000 pacientes con sus cadenas pesa ~5–10 MB.
 */
export const MAX_XLSX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 5000;
/** Última fila de una hoja de Excel. */
export const MAX_SHEET_ROW = 1_048_576;
/** Serie de Excel del 31/12/9999 (la última fecha que admite). */
const MAX_EXCEL_SERIAL = 2_958_465;

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

/** Descompresión con presupuesto compartido entre todas las partes. */
class Inflater {
  private used = 0;

  constructor(
    private readonly zip: Buffer,
    private readonly entries: Map<string, ZipEntry>,
  ) {}

  async part(name: string): Promise<string | null> {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const bytes = await this.read(entry);
    this.used += bytes.length;
    return bytes.toString('utf8');
  }

  private async read(entry: ZipEntry): Promise<Buffer> {
    if (entry.flags & 0x1) throw new ImportFileError(ENCRYPTED_MESSAGE);
    const budget = MAX_XLSX_TOTAL_BYTES - this.used;
    if (entry.uncompressedSize > budget) {
      throw new ImportFileError(TOO_BIG_MESSAGE);
    }
    const zip = this.zip;
    const at = entry.localOffset;
    if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL_SIGNATURE) {
      throw new ImportFileError(NOT_XLSX_MESSAGE);
    }
    const start =
      at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
    const end = start + entry.compressedSize;
    if (end > zip.length) throw new ImportFileError(NOT_XLSX_MESSAGE);
    const data = zip.subarray(start, end);
    if (entry.method === 0) {
      if (data.length > budget) throw new ImportFileError(TOO_BIG_MESSAGE);
      return data;
    }
    if (entry.method !== 8) throw new ImportFileError(NOT_XLSX_MESSAGE);
    try {
      // El tope es el presupuesto que queda, no lo que DICE la cabecera.
      return await inflateRawAsync(data, {
        maxOutputLength: Math.max(1, budget),
      });
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

/**
 * Elementos `<prefijo:nombre …>…</prefijo:nombre>` (o `<… />`) de un texto,
 * con un cursor que solo avanza: lineal en el tamaño del texto. Una
 * etiqueta de apertura sin su cierre es un fichero mal formado.
 */
interface XmlElement {
  attrs: string;
  /** Contenido entre la apertura y el cierre ('' si es `<… />`). */
  body: string;
}

function* elements(xml: string, name: string): Generator<XmlElement> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let i = 0;
  for (;;) {
    const start = xml.indexOf(open, i);
    if (start === -1) return;
    const after = xml.charCodeAt(start + open.length);
    // `<c` no es `<cols`: tras el nombre va espacio, `>` o `/`.
    if (!(
      after === 0x20 ||
      after === 0x3e ||
      after === 0x2f ||
      after === 0x09 ||
      after === 0x0a ||
      after === 0x0d
    )) {
      i = start + open.length;
      continue;
    }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd === -1) throw new ImportFileError(NOT_XLSX_MESSAGE);
    const selfClosing = xml.charCodeAt(tagEnd - 1) === 0x2f;
    const attrs = xml.slice(
      start + open.length,
      selfClosing ? tagEnd - 1 : tagEnd,
    );
    if (selfClosing) {
      i = tagEnd + 1;
      yield { attrs, body: '' };
      continue;
    }
    const end = xml.indexOf(close, tagEnd + 1);
    if (end === -1) throw new ImportFileError(NOT_XLSX_MESSAGE);
    i = end + close.length;
    yield { attrs, body: xml.slice(tagEnd + 1, end) };
  }
}

/** Primer elemento `name` del texto, o null. */
function first(xml: string, name: string): XmlElement | null {
  for (const el of elements(xml, name)) return el;
  return null;
}

/** Prefijo de espacio de nombres del elemento raíz (`x:` en `<x:worksheet>`). */
function prefixOf(xml: string, root: string): string {
  const m = new RegExp(`<([A-Za-z_][\\w.-]*:)?${root}[\\s>/]`).exec(
    xml.slice(0, 4096),
  );
  return m?.[1] ?? '';
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(
    attrs,
  );
  return m ? decodeXmlText(m[1] ?? m[2] ?? '') : null;
}

/** Texto de los `<t>` de un fragmento (sin la fonética `<rPh>`). */
function runsText(xml: string, p: string): string {
  let out = '';
  let i = 0;
  const phonetic = `<${p}rPh`;
  const phoneticEnd = `</${p}rPh>`;
  // Fuera la fonética (lineal: cursor).
  let clean = '';
  for (;;) {
    const start = xml.indexOf(phonetic, i);
    if (start === -1) {
      clean += xml.slice(i);
      break;
    }
    clean += xml.slice(i, start);
    const end = xml.indexOf(phoneticEnd, start);
    if (end === -1) throw new ImportFileError(NOT_XLSX_MESSAGE);
    i = end + phoneticEnd.length;
  }
  for (const t of elements(clean, `${p}t`)) {
    if (out.length < MAX_CELL_CHARS) out += decodeXmlText(t.body);
  }
  return out.slice(0, MAX_CELL_CHARS);
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const p = prefixOf(xml, 'sst');
  const out: string[] = [];
  for (const si of elements(xml, `${p}si`)) out.push(runsText(si.body, p));
  return out;
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
  const p = prefixOf(xml, 'styleSheet');
  const custom = new Map<number, string>();
  for (const f of elements(xml, `${p}numFmt`)) {
    const id = attr(f.attrs, 'numFmtId');
    const code = attr(f.attrs, 'formatCode');
    if (id !== null && code !== null) custom.set(Number(id), code);
  }
  const xfs = first(xml, `${p}cellXfs`);
  if (!xfs) return [];
  return [...elements(xfs.body, `${p}xf`)].map((xf) => {
    const id = Number(attr(xf.attrs, 'numFmtId') ?? '0');
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
  if (!Number.isFinite(serial) || serial < 1 || serial > MAX_EXCEL_SERIAL) {
    return null;
  }
  const days = Math.floor(serial) + (date1904 ? 1462 : 0);
  // Excel cuenta el 29/02/1900 inexistente: desde el 1/03/1900 se resta 1.
  const epoch = Date.UTC(1899, 11, days >= 61 ? 30 : 31);
  const d = new Date(epoch + days * 86_400_000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
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

/** Índice de columna de una referencia («AB12» → 27), o -1 si no lo es. */
function columnIndex(ref: string): number {
  const m = /^([A-Z]{1,3})\d*$/.exec(ref);
  if (!m) return -1;
  let index = 0;
  for (const ch of m[1]) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** Ruta de la primera hoja del libro según workbook.xml y sus relaciones. */
function firstSheetPath(workbook: string, rels: string | null): string {
  const p = prefixOf(workbook, 'workbook');
  const sheet = first(workbook, `${p}sheet`);
  const relId = sheet ? attr(sheet.attrs, 'r:id') : null;
  if (rels && relId) {
    const rp = prefixOf(rels, 'Relationships');
    for (const r of elements(rels, `${rp}Relationship`)) {
      if (attr(r.attrs, 'Id') !== relId) continue;
      const target = attr(r.attrs, 'Target') ?? '';
      return target.startsWith('/')
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, '')}`;
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/**
 * Lee la primera hoja del libro: descomprime (asíncrono, con tope) y
 * devuelve un generador de registros con su número de fila. Las filas sin
 * nada escrito no se emiten; el número de fila `r` vale si es un entero de
 * 1 a 1.048.576 mayor que el anterior (si no, el siguiente al anterior).
 */
export async function readXlsx(bytes: Buffer): Promise<Iterable<RawRecord>> {
  const entries = readEntries(bytes);
  if (entries.has('EncryptionInfo'))
    throw new ImportFileError(ENCRYPTED_MESSAGE);
  const inflater = new Inflater(bytes, entries);
  const workbook = await inflater.part('xl/workbook.xml');
  if (!workbook) throw new ImportFileError(NOT_XLSX_MESSAGE);
  const date1904 =
    /<(?:[\w.-]+:)?workbookPr\b[^>]*\bdate1904=["'](1|true)["']/.test(
      workbook.slice(0, 64 * 1024),
    );
  const sheetPath = firstSheetPath(
    workbook,
    await inflater.part('xl/_rels/workbook.xml.rels'),
  );
  const sheetXml = await inflater.part(sheetPath);
  if (!sheetXml) throw new ImportFileError(NOT_XLSX_MESSAGE);
  const strings = sharedStrings(await inflater.part('xl/sharedStrings.xml'));
  const dates = dateStyles(await inflater.part('xl/styles.xml'));
  return sheetRecords(sheetXml, strings, dates, date1904);
}

function* sheetRecords(
  sheetXml: string,
  strings: string[],
  dates: boolean[],
  date1904: boolean,
): Generator<RawRecord> {
  const p = prefixOf(sheetXml, 'worksheet');
  // Sin <sheetData> (hoja escrita a mano), se buscan las filas en toda ella.
  const data = first(sheetXml, `${p}sheetData`);
  let lastRow = 0;
  for (const row of elements(data ? data.body : sheetXml, `${p}row`)) {
    const declared = Number(attr(row.attrs, 'r'));
    const r =
      Number.isInteger(declared) &&
      declared > lastRow &&
      declared <= MAX_SHEET_ROW
        ? declared
        : lastRow + 1;
    lastRow = r;
    if (row.body === '') {
      // Fila vacía: cuenta como fila física pero no lleva celdas.
      yield { rowNumber: r, cells: [] };
      continue;
    }
    const cells: string[] = [];
    let overflow = false;
    let lastCol = -1;
    for (const c of elements(row.body, `${p}c`)) {
      const ref = attr(c.attrs, 'r');
      const col = ref ? columnIndex(ref) : lastCol + 1;
      if (col < 0) continue;
      lastCol = col;
      const text = cellText(c, p, strings, dates, date1904);
      if (col >= MAX_COLUMNS) {
        if (text.trim() !== '') overflow = true;
        continue;
      }
      while (cells.length < col) cells.push('');
      cells[col] = text;
    }
    yield { rowNumber: r, cells, ...(overflow ? { overflow } : {}) };
  }
}

function cellText(
  c: XmlElement,
  p: string,
  strings: string[],
  dates: boolean[],
  date1904: boolean,
): string {
  const type = attr(c.attrs, 't') ?? 'n';
  if (type === 'inlineStr') {
    const is = first(c.body, `${p}is`);
    return is ? runsText(is.body, p) : '';
  }
  const v = first(c.body, `${p}v`);
  if (!v) return '';
  switch (type) {
    case 's':
      return strings[Number(v.body)] ?? '';
    case 'b':
      return v.body === '1' ? 'VERDADERO' : 'FALSO';
    case 'e':
      // #N/A, #¡VALOR!…: la celda no tiene dato.
      return '';
    case 'str':
      return decodeXmlText(v.body).slice(0, MAX_CELL_CHARS);
    default: {
      const style = Number(attr(c.attrs, 's') ?? '0');
      return dates[style]
        ? (excelSerialToDate(Number(v.body), date1904) ?? numberText(v.body))
        : numberText(v.body);
    }
  }
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
