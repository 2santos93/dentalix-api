import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import {
  ImportFileError,
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  type RawRecord,
  yieldToEventLoop,
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
 * - Topes de ESTRUCTURA (revisión 2026-10-23, B1): un XML diminuto
 *   comprimido puede traer millones de elementos vacíos. Como mucho 16.384
 *   `<c>` por fila (columna XFD), 64.000 estilos `<xf>` (el máximo de
 *   Excel), 1.000.000 de cadenas compartidas y un presupuesto GLOBAL de
 *   pasos del escáner por fichero (cada etiqueta encontrada, también las que
 *   solo se parecen, como `<cx>` buscando `<c>`). Pasarse es un 400. Los
 *   bucles grandes (filas, celdas, cadenas, estilos, relaciones) son
 *   asíncronos y ceden el hilo cada `YIELD_STEPS` pasos; los pequeños
 *   (dentro de una celda) tienen su propio tope síncrono.
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

/** Celdas `<c>` por fila como mucho: la última columna de Excel es XFD. */
export const MAX_CELLS_PER_ROW = 16_384;
/** Estilos de celda `<xf>` (y formatos `<numFmt>`) como mucho: el máximo de Excel. */
export const MAX_CELL_STYLES = 64_000;
/**
 * Cadenas compartidas `<si>` como mucho: 10.000 pacientes × 100 columnas.
 * Una tabla mayor no es la de un listado de pacientes.
 */
export const MAX_SHARED_STRINGS = 1_000_000;
/**
 * Pasos del escáner XML por fichero (cada etiqueta encontrada, coincida o
 * no). Un libro real de 10.000 pacientes × 20 columnas da ~0,5 M.
 */
export const MAX_XML_STEPS = 4_000_000;
/** Pasos de un bucle síncrono pequeño (dentro de una celda, una cabecera). */
const MAX_SYNC_STEPS = 4_096;
/** Cada cuántos pasos del escáner se cede el hilo en los bucles grandes. */
const YIELD_STEPS = 8_192;
/** Una etiqueta de apertura más larga (atributos) no es de un .xlsx. */
const MAX_TAG_CHARS = 16 * 1024;

const TOO_MANY_CELLS_MESSAGE =
  'Una fila de la hoja tiene más de 16.384 celdas (el máximo de Excel). Ábrela en Excel y guárdala de nuevo como .xlsx o como CSV.';
const TOO_MANY_STYLES_MESSAGE =
  'El Excel tiene más de 64.000 estilos de celda (el máximo de Excel). Ábrelo en Excel y guárdalo de nuevo como .xlsx o como CSV.';
const TOO_MANY_STRINGS_MESSAGE =
  'El Excel tiene más de 1.000.000 de cadenas de texto: no parece un listado de pacientes. Guarda solo la hoja de pacientes como .xlsx o como CSV.';
const TOO_COMPLEX_MESSAGE =
  'El Excel es demasiado complejo para importarlo (tiene demasiados elementos). Guarda solo la hoja de pacientes como .xlsx o como CSV.';

/**
 * Presupuesto de pasos del escáner de UN fichero y cuándo toca ceder el
 * hilo. Se comparte entre todas las partes (cadenas, estilos, hoja).
 */
class XmlBudget {
  private steps = 0;
  private sinceRest = 0;

  constructor(private readonly maxSteps: number) {}

  step(): void {
    this.steps += 1;
    this.sinceRest += 1;
    if (this.steps > this.maxSteps) {
      throw new ImportFileError(TOO_COMPLEX_MESSAGE);
    }
  }

  get restDue(): boolean {
    return this.sinceRest >= YIELD_STEPS;
  }

  async rest(): Promise<void> {
    this.sinceRest = 0;
    await yieldToEventLoop();
  }
}

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

/** Marca del escáner: toca ceder el hilo (solo la atienden los bucles asíncronos). */
const PAUSE = Symbol('pause');

/**
 * Escáner base: cada etiqueta que empieza por `<name` es un paso del
 * presupuesto (también `<cols` buscando `<c`); `maxSteps` acota los pasos
 * de ESTA búsqueda (bucles síncronos).
 */
function* scan(
  xml: string,
  name: string,
  budget: XmlBudget,
  maxSteps: number,
): Generator<XmlElement | typeof PAUSE> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let i = 0;
  let steps = 0;
  for (;;) {
    const start = xml.indexOf(open, i);
    if (start === -1) return;
    budget.step();
    steps += 1;
    if (steps > maxSteps) throw new ImportFileError(TOO_COMPLEX_MESSAGE);
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
      if (budget.restDue) yield PAUSE;
      continue;
    }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd === -1 || tagEnd - start > MAX_TAG_CHARS) {
      throw new ImportFileError(NOT_XLSX_MESSAGE);
    }
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

/** Bucle síncrono pequeño: como mucho `MAX_SYNC_STEPS` pasos. */
function* elements(
  xml: string,
  name: string,
  budget: XmlBudget,
): Generator<XmlElement> {
  for (const el of scan(xml, name, budget, MAX_SYNC_STEPS)) {
    if (el !== PAUSE) yield el;
  }
}

/**
 * Bucle grande: asíncrono, cede el hilo cada `YIELD_STEPS` pasos (también
 * los que gasta quien consume cada elemento) y como mucho `limit`
 * elementos (si no, 400 con `message`).
 */
async function* each(
  xml: string,
  name: string,
  budget: XmlBudget,
  limit: number,
  message: string,
): AsyncGenerator<XmlElement> {
  let count = 0;
  for (const el of scan(xml, name, budget, Number.POSITIVE_INFINITY)) {
    if (el !== PAUSE) {
      count += 1;
      if (count > limit) throw new ImportFileError(message);
      yield el;
    }
    if (budget.restDue) await budget.rest();
  }
}

/** Primer elemento `name` del texto, o null. */
function first(
  xml: string,
  name: string,
  budget: XmlBudget,
): XmlElement | null {
  for (const el of elements(xml, name, budget)) return el;
  return null;
}

/** Prefijo de espacio de nombres del elemento raíz (`x:` en `<x:worksheet>`). */
function prefixOf(xml: string, root: string): string {
  const m = new RegExp(`<([A-Za-z_][\\w.-]*:)?${root}[\\s>/]`).exec(
    xml.slice(0, 4096),
  );
  return m?.[1] ?? '';
}

/** Expresión de cada atributo, compilada una vez (no una por celda). */
const ATTR_PATTERNS = new Map<string, RegExp>();

function attr(attrs: string, name: string): string | null {
  let pattern = ATTR_PATTERNS.get(name);
  if (!pattern) {
    pattern = new RegExp(
      `(?:^|\\s)${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    );
    ATTR_PATTERNS.set(name, pattern);
  }
  const m = pattern.exec(attrs);
  return m ? decodeXmlText(m[1] ?? m[2] ?? '') : null;
}

/** Texto de los `<t>` de un fragmento (sin la fonética `<rPh>`). */
function runsText(xml: string, p: string, budget: XmlBudget): string {
  let out = '';
  let i = 0;
  const phonetic = `<${p}rPh`;
  const phoneticEnd = `</${p}rPh>`;
  // Fuera la fonética (lineal: cursor; con tope de pasos, como `elements`).
  let clean = '';
  let steps = 0;
  for (;;) {
    const start = xml.indexOf(phonetic, i);
    if (start === -1) {
      clean += xml.slice(i);
      break;
    }
    budget.step();
    steps += 1;
    if (steps > MAX_SYNC_STEPS) throw new ImportFileError(TOO_COMPLEX_MESSAGE);
    clean += xml.slice(i, start);
    const end = xml.indexOf(phoneticEnd, start);
    if (end === -1) throw new ImportFileError(NOT_XLSX_MESSAGE);
    i = end + phoneticEnd.length;
  }
  for (const t of elements(clean, `${p}t`, budget)) {
    if (out.length < MAX_CELL_CHARS) out += decodeXmlText(t.body);
  }
  return out.slice(0, MAX_CELL_CHARS);
}

async function sharedStrings(
  xml: string | null,
  budget: XmlBudget,
): Promise<string[]> {
  if (!xml) return [];
  const p = prefixOf(xml, 'sst');
  const out: string[] = [];
  for await (const si of each(
    xml,
    `${p}si`,
    budget,
    MAX_SHARED_STRINGS,
    TOO_MANY_STRINGS_MESSAGE,
  )) {
    out.push(si.body === '' ? '' : runsText(si.body, p, budget));
  }
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
async function dateStyles(
  xml: string | null,
  budget: XmlBudget,
): Promise<boolean[]> {
  if (!xml) return [];
  const p = prefixOf(xml, 'styleSheet');
  const custom = new Map<number, string>();
  for await (const f of each(
    xml,
    `${p}numFmt`,
    budget,
    MAX_CELL_STYLES,
    TOO_MANY_STYLES_MESSAGE,
  )) {
    const id = attr(f.attrs, 'numFmtId');
    const code = attr(f.attrs, 'formatCode');
    if (id !== null && code !== null) custom.set(Number(id), code);
  }
  const xfs = first(xml, `${p}cellXfs`, budget);
  if (!xfs) return [];
  const out: boolean[] = [];
  for await (const xf of each(
    xfs.body,
    `${p}xf`,
    budget,
    MAX_CELL_STYLES,
    TOO_MANY_STYLES_MESSAGE,
  )) {
    const id = Number(attr(xf.attrs, 'numFmtId') ?? '0');
    const code = custom.get(id);
    out.push(
      code !== undefined
        ? isDateFormatCode(code)
        : BUILTIN_DATE_FORMATS.has(id),
    );
  }
  return out;
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
async function firstSheetPath(
  workbook: string,
  rels: string | null,
  budget: XmlBudget,
): Promise<string> {
  const p = prefixOf(workbook, 'workbook');
  const sheet = first(workbook, `${p}sheet`, budget);
  const relId = sheet ? attr(sheet.attrs, 'r:id') : null;
  if (rels && relId) {
    const rp = prefixOf(rels, 'Relationships');
    for await (const r of each(
      rels,
      `${rp}Relationship`,
      budget,
      MAX_ENTRIES,
      NOT_XLSX_MESSAGE,
    )) {
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
 * Solo para tests (DX-209): un presupuesto de pasos MENOR que
 * `MAX_XML_STEPS`, para probar el mecanismo del tope global sin dar 4 M
 * pasos. Producción llama sin opciones; un valor mayor se ignora.
 */
export interface ReadXlsxOptions {
  maxXmlSteps?: number;
}

/**
 * Lee la primera hoja del libro: descomprime (asíncrono, con tope) y
 * devuelve un generador ASÍNCRONO de registros con su número de fila (cede
 * el hilo cada `YIELD_STEPS` pasos del escáner, también dentro de una
 * fila). Las filas sin nada escrito no se emiten; el número de fila `r`
 * vale si es un entero de 1 a 1.048.576 mayor que el anterior (si no, el
 * siguiente al anterior).
 */
export async function readXlsx(
  bytes: Buffer,
  options: ReadXlsxOptions = {},
): Promise<AsyncIterable<RawRecord>> {
  const entries = readEntries(bytes);
  if (entries.has('EncryptionInfo'))
    throw new ImportFileError(ENCRYPTED_MESSAGE);
  const inflater = new Inflater(bytes, entries);
  // Solo se puede BAJAR: ningún llamador sube el tope de producción.
  const budget = new XmlBudget(
    Math.min(options.maxXmlSteps ?? MAX_XML_STEPS, MAX_XML_STEPS),
  );
  const workbook = await inflater.part('xl/workbook.xml');
  if (!workbook) throw new ImportFileError(NOT_XLSX_MESSAGE);
  const date1904 =
    /<(?:[\w.-]+:)?workbookPr\b[^>]*\bdate1904=["'](1|true)["']/.test(
      workbook.slice(0, 64 * 1024),
    );
  const sheetPath = await firstSheetPath(
    workbook,
    await inflater.part('xl/_rels/workbook.xml.rels'),
    budget,
  );
  const sheetXml = await inflater.part(sheetPath);
  if (!sheetXml) throw new ImportFileError(NOT_XLSX_MESSAGE);
  const strings = await sharedStrings(
    await inflater.part('xl/sharedStrings.xml'),
    budget,
  );
  const dates = await dateStyles(await inflater.part('xl/styles.xml'), budget);
  return sheetRecords(sheetXml, strings, dates, date1904, budget);
}

async function* sheetRecords(
  sheetXml: string,
  strings: string[],
  dates: boolean[],
  date1904: boolean,
  budget: XmlBudget,
): AsyncGenerator<RawRecord> {
  const p = prefixOf(sheetXml, 'worksheet');
  // Sin <sheetData> (hoja escrita a mano), se buscan las filas en toda ella.
  const data = first(sheetXml, `${p}sheetData`, budget);
  let lastRow = 0;
  // Las filas físicas las acota TableBuilder (MAX_PHYSICAL_ROWS) y el presupuesto.
  for await (const row of each(
    data ? data.body : sheetXml,
    `${p}row`,
    budget,
    Number.POSITIVE_INFINITY,
    TOO_COMPLEX_MESSAGE,
  )) {
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
    for await (const c of each(
      row.body,
      `${p}c`,
      budget,
      MAX_CELLS_PER_ROW,
      TOO_MANY_CELLS_MESSAGE,
    )) {
      const ref = attr(c.attrs, 'r');
      const col = ref ? columnIndex(ref) : lastCol + 1;
      if (col < 0) continue;
      lastCol = col;
      if (col >= MAX_COLUMNS) {
        // Fuera de las columnas que se guardan: solo importa si hay algo.
        if (
          !overflow &&
          cellText(c, p, strings, dates, date1904, budget).trim() !== ''
        ) {
          overflow = true;
        }
        continue;
      }
      const text = cellText(c, p, strings, dates, date1904, budget);
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
  budget: XmlBudget,
): string {
  if (c.body === '') return '';
  const type = attr(c.attrs, 't') ?? 'n';
  if (type === 'inlineStr') {
    const is = first(c.body, `${p}is`, budget);
    return is ? runsText(is.body, p, budget) : '';
  }
  const v = first(c.body, `${p}v`, budget);
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
