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
  if (startsWith(bytes, ZIP_LOCAL_MAGIC)) {
    return zipHasEntry(bytes, 'word/document.xml') ? DOCX_TYPE : null;
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

/**
 * ¿El directorio central del ZIP tiene una entrada con ese nombre? Busca el
 * registro de fin (EOCD) desde el final (puede llevar un comentario de hasta
 * 64 KB) y recorre las entradas con todos los límites comprobados: un ZIP
 * roto o malicioso da false, nunca una excepción. Solo cuentan los NOMBRES de
 * entrada; un fichero que solo menciona `word/document.xml` no es un DOCX.
 * ZIP64 no se admite (un DOCX de ≤ 20 MB no lo necesita).
 */
function zipHasEntry(bytes: Buffer, wanted: string): boolean {
  if (bytes.length < EOCD_MIN) return false;
  const lowest = Math.max(0, bytes.length - EOCD_MIN - MAX_ZIP_COMMENT);
  let eocd = -1;
  for (let i = bytes.length - EOCD_MIN; i >= lowest; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;

  const entries = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  const start = bytes.readUInt32LE(eocd + 16);
  if (start + size > eocd) return false;

  const name = Buffer.from(wanted, 'utf8');
  let p = start;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || bytes.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      return false;
    }
    const nameLength = bytes.readUInt16LE(p + 28);
    const extraLength = bytes.readUInt16LE(p + 30);
    const commentLength = bytes.readUInt16LE(p + 32);
    const nameStart = p + 46;
    if (nameStart + nameLength > eocd) return false;
    if (bytes.subarray(nameStart, nameStart + nameLength).equals(name)) {
      return true;
    }
    p = nameStart + nameLength + extraLength + commentLength;
  }
  return false;
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
 * Solo PDF, JPEG y PNG se abren en el navegador (visor con `sandbox`); HEIC,
 * DOCX y DICOM solo se descargan.
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
  [DOCX_TYPE]: [DOCX_TYPE],
  'application/dicom': ['application/dicom'],
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
