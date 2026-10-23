/**
 * DX-151: tipo REAL de un documento del paciente por su contenido (no por la
 * etiqueta del multipart ni por la extensión). Lista blanca cerrada: lo que
 * no se reconoce aquí (SVG, HTML, EML, texto, un Excel, …) no llega al
 * almacén. Mismo estilo que `sniffAvatarImage` (DX-084).
 */
export type DetectedType =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'image/heic'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/dicom';

const DOCX_TYPE: DetectedType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** 20 MB: tope del use-case Y del multer (el 413 sale antes de leer más). */
export const MAX_PATIENT_DOCUMENT_BYTES = 20 * 1024 * 1024;

export const UNSUPPORTED_TYPE_MESSAGE =
  'Tipo de archivo no admitido. Se aceptan PDF, JPG, PNG, HEIC, DOCX y DICOM.';
export const TYPE_MISMATCH_MESSAGE =
  'El contenido del archivo no coincide con su tipo.';
export const FILE_TOO_LARGE_MESSAGE = 'El archivo supera el máximo de 20 MB.';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const ZIP_LOCAL_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** Marcas principales de la caja `ftyp` que son HEIC/HEIF. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'hevc']);
const DICOM_PREAMBLE = 128;

const startsWith = (bytes: Buffer, magic: Buffer): boolean =>
  bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);

export function sniffDocument(bytes: Buffer): DetectedType | null {
  if (startsWith(bytes, PDF_MAGIC)) return 'application/pdf';
  if (startsWith(bytes, JPEG_MAGIC)) return 'image/jpeg';
  // PNG estricto: firma de 8 bytes y el primer chunk es IHDR.
  if (
    startsWith(bytes, PNG_MAGIC) &&
    bytes.length >= 16 &&
    bytes.toString('latin1', 12, 16) === 'IHDR'
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 4, 8) === 'ftyp' &&
    HEIC_BRANDS.has(bytes.toString('latin1', 8, 12))
  ) {
    return 'image/heic';
  }
  // Un ZIP sin `word/document.xml` sigue: el preámbulo libre de un DICOM
  // puede empezar por `PK\x03\x04`.
  if (
    startsWith(bytes, ZIP_LOCAL_MAGIC) &&
    zipHasEntry(bytes, 'word/document.xml')
  ) {
    return DOCX_TYPE;
  }
  if (
    bytes.length >= DICOM_PREAMBLE + 4 &&
    bytes.toString('latin1', DICOM_PREAMBLE, DICOM_PREAMBLE + 4) === 'DICM'
  ) {
    return 'application/dicom';
  }
  return null;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN = 22;
const MAX_ZIP_COMMENT = 0xffff;

/** Bytes del final de un ZIP donde puede estar el registro de fin (EOCD). */
export const ZIP_TAIL_BYTES = EOCD_MIN + MAX_ZIP_COMMENT;

/**
 * Directorio central más grande que se acepta leer por rango (DX-259). El de
 * un DOCX ocupa unos pocos KB; uno enorme no es un DOCX razonable.
 */
export const MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 1024 * 1024;

interface ZipDirectory {
  /** Offset ABSOLUTO del directorio central en el fichero. */
  start: number;
  size: number;
  entries: number;
}

/**
 * Busca el registro de fin (EOCD) en `tail`, los últimos bytes del fichero
 * (`tailOffset` es dónde empiezan); puede llevar un comentario de hasta
 * 64 KB. null si no hay o el directorio que anuncia no cabe antes del EOCD.
 */
function findZipDirectory(
  tail: Buffer,
  tailOffset: number,
): ZipDirectory | null {
  if (tail.length < EOCD_MIN) return null;
  const lowest = Math.max(0, tail.length - EOCD_MIN - MAX_ZIP_COMMENT);
  for (let i = tail.length - EOCD_MIN; i >= lowest; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const entries = tail.readUInt16LE(i + 10);
    const size = tail.readUInt32LE(i + 12);
    const start = tail.readUInt32LE(i + 16);
    if (start + size > tailOffset + i) return null;
    return { start, size, entries };
  }
  return null;
}

/**
 * ¿El directorio central (`central`, ya recortado a su tamaño) tiene una
 * entrada con ese nombre? Todos los límites comprobados: un ZIP roto o
 * malicioso da false, nunca una excepción.
 */
function centralHasEntry(
  central: Buffer,
  entries: number,
  wanted: string,
): boolean {
  const name = Buffer.from(wanted, 'utf8');
  let p = 0;
  for (let n = 0; n < entries; n++) {
    if (
      p + 46 > central.length ||
      central.readUInt32LE(p) !== CENTRAL_SIGNATURE
    ) {
      return false;
    }
    const nameLength = central.readUInt16LE(p + 28);
    const extraLength = central.readUInt16LE(p + 30);
    const commentLength = central.readUInt16LE(p + 32);
    const nameStart = p + 46;
    if (nameStart + nameLength > central.length) return false;
    if (central.subarray(nameStart, nameStart + nameLength).equals(name)) {
      return true;
    }
    p = nameStart + nameLength + extraLength + commentLength;
  }
  return false;
}

/**
 * ¿El directorio central del ZIP tiene una entrada con ese nombre? Solo
 * cuentan los NOMBRES de entrada; un fichero que solo menciona
 * `word/document.xml` no es un DOCX. ZIP64 no se admite (un DOCX de ≤ 20 MB
 * no lo necesita).
 */
function zipHasEntry(bytes: Buffer, wanted: string): boolean {
  const dir = findZipDirectory(bytes, 0);
  if (!dir) return false;
  return centralHasEntry(
    bytes.subarray(dir.start, dir.start + dir.size),
    dir.entries,
    wanted,
  );
}

/**
 * Lectura por rangos de un fichero que no está en memoria (DX-259: el objeto
 * subido directamente al bucket se lee con `Range`). `read(start, end)` da
 * los bytes `[start, end)`.
 */
export interface ByteRangeSource {
  size: number;
  read(start: number, end: number): Promise<Buffer>;
}

/** Bytes del principio que bastan para todas las firmas salvo la del DOCX. */
export const SNIFF_HEAD_BYTES = 64 * 1024;

/**
 * `sniffDocument` sin tener el fichero entero (DX-259): lee los primeros
 * 64 KB y, solo si empieza como un ZIP, el final (EOCD) y el directorio
 * central. El resultado es el mismo que con el fichero completo.
 */
export async function sniffDocumentFrom(
  source: ByteRangeSource,
): Promise<DetectedType | null> {
  const head = await source.read(0, Math.min(source.size, SNIFF_HEAD_BYTES));
  // Lo que no empieza como un ZIP se decide con la cabecera (las firmas
  // están en los primeros 132 bytes). Un ZIP se decide por su final.
  if (source.size <= SNIFF_HEAD_BYTES || !startsWith(head, ZIP_LOCAL_MAGIC)) {
    return sniffDocument(head);
  }
  const tailStart = Math.max(0, source.size - ZIP_TAIL_BYTES);
  const tail = await source.read(tailStart, source.size);
  const dir = findZipDirectory(tail, tailStart);
  if (dir && dir.size <= MAX_ZIP_CENTRAL_DIRECTORY_BYTES) {
    const central =
      dir.start >= tailStart
        ? tail.subarray(dir.start - tailStart, dir.start - tailStart + dir.size)
        : await source.read(dir.start, dir.start + dir.size);
    if (centralHasEntry(central, dir.entries, 'word/document.xml')) {
      return DOCX_TYPE;
    }
  }
  // Un ZIP que no es DOCX puede ser el preámbulo libre de un DICOM.
  return head.length >= DICOM_PREAMBLE + 4 &&
    head.toString('latin1', DICOM_PREAMBLE, DICOM_PREAMBLE + 4) === 'DICM'
    ? 'application/dicom'
    : null;
}

const EXTENSIONS: Record<DetectedType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  [DOCX_TYPE]: 'docx',
  'application/dicom': 'dcm',
};

/** Extensión de la clave en el almacén (la fija el tipo detectado). */
export function extensionOf(type: DetectedType): string {
  return EXTENSIONS[type];
}

/**
 * Solo PDF, JPEG y PNG se abren en el navegador (el iframe no lleva
 * `sandbox`: lo protegen la lista de tipos firmados en la URL y `nosniff`);
 * HEIC, DOCX y DICOM solo se descargan.
 */
export function isInlineViewable(type: DetectedType): boolean {
  return (
    type === 'application/pdf' || type === 'image/jpeg' || type === 'image/png'
  );
}

/** Etiquetas MIME que el navegador puede mandar para cada tipo. */
const MIME_ALIASES: Record<DetectedType, readonly string[]> = {
  'application/pdf': ['application/pdf', 'application/x-pdf'],
  'image/jpeg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  'image/png': ['image/png', 'image/x-png'],
  'image/heic': [
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
  ],
  // Algunos navegadores etiquetan un .docx como ZIP genérico.
  [DOCX_TYPE]: [DOCX_TYPE, 'application/zip', 'application/x-zip-compressed'],
  'application/dicom': [
    'application/dicom',
    'application/x-dicom',
    'image/dicom',
  ],
};

/** Extensiones de nombre que corresponden a cada tipo. */
const NAME_EXTENSIONS: Record<DetectedType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
  'image/heic': ['heic', 'heif'],
  [DOCX_TYPE]: ['docx'],
  'application/dicom': ['dcm', 'dicom'],
};

/** Etiquetas que no afirman nada (DICOM y HEIC suelen llegar así). */
const GENERIC_MIME = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);

const KNOWN_NAME_EXTENSIONS = new Set(Object.values(NAME_EXTENSIONS).flat());

/**
 * ¿Lo que DICE el cliente cuadra con lo que ES? Una etiqueta MIME concreta
 * tiene que ser un alias del tipo detectado (un PNG que llega como
 * `image/svg+xml` o `application/pdf` no cuadra). La extensión del nombre,
 * si es de un tipo de la lista blanca, también tiene que ser la suya (un
 * PNG llamado `informe.pdf` no cuadra); una extensión desconocida o ninguna
 * (DICOM sin extensión, `IM000001`) no dice nada. Si no cuadra:
 * TYPE_MISMATCH_MESSAGE.
 */
export function declaredTypeMatches(
  declared: { mimeType?: string | null; originalName?: string | null },
  detected: DetectedType,
): boolean {
  const mime = (declared.mimeType ?? '').trim().toLowerCase().split(';')[0];
  if (!GENERIC_MIME.has(mime) && !MIME_ALIASES[detected].includes(mime)) {
    return false;
  }
  const match = /\.([^./\\]+)$/.exec(declared.originalName ?? '');
  const ext = match ? match[1].toLowerCase() : '';
  if (
    KNOWN_NAME_EXTENSIONS.has(ext) &&
    !NAME_EXTENSIONS[detected].includes(ext)
  ) {
    return false;
  }
  return true;
}

/**
 * `sniffDocumentFrom` restringido a una lista blanca más estrecha (DX-274:
 * el soporte de un gasto admite solo PDF, JPG y PNG): lo que se reconoce pero
 * no está en `allowed` también es null.
 */
export async function sniffRestrictedFrom<T extends DetectedType>(
  source: ByteRangeSource,
  allowed: readonly T[],
): Promise<T | null> {
  const detected = await sniffDocumentFrom(source);
  return detected !== null &&
    (allowed as readonly DetectedType[]).includes(detected)
    ? (detected as T)
    : null;
}
