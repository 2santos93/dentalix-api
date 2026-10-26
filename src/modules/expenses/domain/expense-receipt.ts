import {
  type ByteRangeSource,
  MAX_PATIENT_DOCUMENT_BYTES,
  sniffRestrictedFrom,
} from '../../../shared/storage/document-content';
import {
  RECEIPT_MIME_TYPES,
  type ReceiptMimeType,
} from './entities/expense.entity';

/**
 * Soporte del gasto (DX-274, R7): PDF, JPG o PNG de hasta 20 MB, decidido por
 * el CONTENIDO (lista blanca restringida sobre el mismo detector que los
 * documentos del paciente). HEIC se convierte a JPG en el navegador.
 */
export const MAX_RECEIPT_BYTES = MAX_PATIENT_DOCUMENT_BYTES;

export const RECEIPT_TYPE_MESSAGE =
  'El soporte debe ser un PDF o una imagen JPG o PNG.';
export const RECEIPT_REJECTED_CODE = 'EXPENSE_RECEIPT_REJECTED';

/** Las URL firmadas para ver o descargar el soporte viven 5 minutos. */
export const RECEIPT_URL_TTL_SECONDS = 300;
/** El POST prefirmado vale 15 minutos (como los documentos del paciente). */
export const RECEIPT_UPLOAD_TTL_SECONDS = 15 * 60;

export function isReceiptType(type: string | null): type is ReceiptMimeType {
  return (RECEIPT_MIME_TYPES as readonly string[]).includes(type ?? '');
}

/**
 * El detector por contenido compartido, restringido a la lista blanca del
 * soporte: lo que se reconoce pero no es PDF/JPG/PNG (HEIC, DOCX, DICOM)
 * también es null.
 */
export function sniffReceiptFrom(
  source: ByteRangeSource,
): Promise<ReceiptMimeType | null> {
  return sniffRestrictedFrom(source, RECEIPT_MIME_TYPES);
}

const EXTENSIONS: Record<ReceiptMimeType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertUuids(label: string, tenantId: string, uploadId: string): void {
  if (!UUID.test(tenantId) || !UUID.test(uploadId)) {
    throw new Error(`${label}: tenantId y uploadId deben ser uuid`);
  }
}

/**
 * Clave definitiva: `expense-receipts/<tenantId>/<attemptId>-<sha16>.<ext>`.
 * Solo ids, la huella y la extensión del tipo DETECTADO: nada del nombre
 * original (PII) ni del cliente. El attemptId es un UUID nuevo generado
 * por el servidor por completación, independiente del upload pendiente.
 */
export function receiptStorageKey(
  tenantId: string,
  attemptId: string,
  type: ReceiptMimeType,
  sha256: string,
): string {
  assertUuids('receiptStorageKey', tenantId, attemptId);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('receiptStorageKey: sha256 debe ser hex de 64');
  }
  return `expense-receipts/${tenantId}/${attemptId}-${sha256.slice(0, 16)}.${EXTENSIONS[type]}`;
}

/**
 * Donde el navegador deja el fichero antes de adjuntarlo:
 * `expense-receipts/pending/<tenantId>/<uploadId>`. La API no lo sirve nunca;
 * un objeto que se queda aquí lo borra el ciclo de vida del bucket a las 24 h.
 */
export function pendingReceiptKey(tenantId: string, uploadId: string): string {
  assertUuids('pendingReceiptKey', tenantId, uploadId);
  return `expense-receipts/pending/${tenantId}/${uploadId}`;
}

/** Etiquetas MIME que cada navegador puede mandar para cada tipo. */
const MIME_ALIASES: Record<ReceiptMimeType, readonly string[]> = {
  'application/pdf': ['application/pdf', 'application/x-pdf'],
  'image/jpeg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  'image/png': ['image/png', 'image/x-png'],
};

const NAME_EXTENSIONS: Record<ReceiptMimeType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
};

const GENERIC_MIME = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);

function mimeOf(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().split(';')[0];
}

function extensionOfName(name: string | null | undefined): string {
  const match = /\.([^./\\]+)$/.exec(name ?? '');
  return match ? match[1].toLowerCase() : '';
}

/**
 * ¿Lo que DECLARA el cliente al pedir la subida puede ser un soporte
 * admitido? Una etiqueta concreta que no es de PDF/JPG/PNG (p. ej. HEIC o
 * SVG) se rechaza ya, antes de autorizar la subida. Es una comodidad: la
 * decisión final es el contenido.
 */
export function declaredLooksLikeReceipt(declared: {
  mimeType?: string | null;
  name?: string | null;
}): boolean {
  const mime = mimeOf(declared.mimeType);
  if (
    !GENERIC_MIME.has(mime) &&
    !RECEIPT_MIME_TYPES.some((t) => MIME_ALIASES[t].includes(mime))
  ) {
    return false;
  }
  const ext = extensionOfName(declared.name);
  const known = RECEIPT_MIME_TYPES.flatMap((t) => NAME_EXTENSIONS[t]);
  const knownElsewhere = [
    'heic',
    'heif',
    'docx',
    'dcm',
    'dicom',
    'svg',
    'html',
  ];
  return !(knownElsewhere.includes(ext) && !known.includes(ext));
}

/**
 * ¿Lo que DICE el cliente cuadra con lo que ES? Una etiqueta MIME concreta
 * tiene que ser un alias del tipo detectado y la extensión del nombre, si es
 * de un tipo del soporte, también (un PNG llamado `factura.pdf` no cuadra).
 */
export function declaredMatchesDetected(
  declared: { mimeType?: string | null; name?: string | null },
  detected: ReceiptMimeType,
): boolean {
  const mime = mimeOf(declared.mimeType);
  if (!GENERIC_MIME.has(mime) && !MIME_ALIASES[detected].includes(mime)) {
    return false;
  }
  const ext = extensionOfName(declared.name);
  const known = RECEIPT_MIME_TYPES.flatMap((t) => NAME_EXTENSIONS[t]);
  return !(known.includes(ext) && !NAME_EXTENSIONS[detected].includes(ext));
}
