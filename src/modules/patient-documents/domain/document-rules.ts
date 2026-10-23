import { createHash } from 'node:crypto';
import { FDI_TOOTH_NUMBER_PATTERN } from '../../odontogram/application/use-cases/add-tooth-record.use-case';
import { type DetectedType, extensionOf } from './document-content';
import {
  FALLBACK_ORIGINAL_NAME,
  MAX_ORIGINAL_NAME_LENGTH,
  isSha256Hex,
  normalizeOriginalName,
  sha256HexToBase64,
} from '../../../shared/storage/upload-names';

// Se siguen exponiendo desde aquí (los usan los casos de uso y los specs).
export {
  FALLBACK_ORIGINAL_NAME,
  MAX_ORIGINAL_NAME_LENGTH,
  normalizeOriginalName,
  sha256HexToBase64,
};
import type { PatientDocumentCategory } from './entities/patient-document.entity';

/**
 * DX-151: reglas puras de un documento del paciente. Sin Nest ni Prisma: los
 * fallos son `PatientDocumentRuleError` y el use-case los traduce a 400 con
 * el mensaje tal cual (en español, listo para la pantalla).
 */
export class PatientDocumentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatientDocumentRuleError';
  }
}

/** Las URL firmadas para ver o descargar viven 5 minutos. */
export const PATIENT_DOCUMENT_URL_TTL_SECONDS = 300;

/**
 * DX-259: la autorización para subir el fichero directamente al almacén
 * (POST prefirmado) vale 15 minutos: con 3 subidas a la vez desde un móvil
 * lento, la última de la cola puede empezar varios minutos después de pedirla.
 * S3 la comprueba al EMPEZAR la subida, así que una que empezó a tiempo termina.
 */
export const PATIENT_DOCUMENT_UPLOAD_TTL_SECONDS = 15 * 60;

export const MAX_TOOTH_NUMBERS = 8;
export const MAX_NOTES_LENGTH = 500;
export const MAX_VOID_REASON_LENGTH = 500;

/**
 * Longitud en puntos de código, como `char_length` de Postgres (los CHECK de
 * la BD): un emoji cuenta 1, no 2 unidades UTF-16.
 */
const codePoints = (value: string): number => Array.from(value).length;

/** Mismo orden y valores que el enum `PatientDocumentCategory` de la BD. */
export const PATIENT_DOCUMENT_CATEGORIES: readonly PatientDocumentCategory[] = [
  'XRAY',
  'PHOTO',
  'REFERRAL',
  'SIGNED_CONSENT',
  'REPORT',
  'OTHER',
];

export function validateCategory(value: unknown): PatientDocumentCategory {
  if (
    typeof value === 'string' &&
    (PATIENT_DOCUMENT_CATEGORIES as readonly string[]).includes(value)
  ) {
    return value as PatientDocumentCategory;
  }
  throw new PatientDocumentRuleError('La categoría no es válida.');
}

/** Cómo se nombra en el mensaje un elemento que llegó (texto o no). */
const shown = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? 'sin valor');

/** Dientes FDI (0..8, sin repetir), recortados. */
export function validateToothNumbers(
  list: readonly string[] | null | undefined,
): string[] {
  // El cuerpo llega de fuera: un elemento que no es texto da el mensaje FDI,
  // no un TypeError (500).
  const teeth: unknown[] = (list ?? []).map((t: unknown) =>
    typeof t === 'string' ? t.trim() : t,
  );
  if (teeth.length > MAX_TOOTH_NUMBERS) {
    throw new PatientDocumentRuleError('Como mucho 8 dientes por documento.');
  }
  const seen = new Set<string>();
  for (const tooth of teeth) {
    if (typeof tooth !== 'string' || !FDI_TOOTH_NUMBER_PATTERN.test(tooth)) {
      throw new PatientDocumentRuleError(
        `El diente «${shown(tooth)}» no es un número FDI válido.`,
      );
    }
    if (seen.has(tooth)) {
      throw new PatientDocumentRuleError(`El diente «${tooth}» está repetido.`);
    }
    seen.add(tooth);
  }
  return teeth as string[];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Fecha clínica opcional `YYYY-MM-DD` (día de calendario real) que no puede
 * ser posterior a `today` (el día civil de la clínica, también `YYYY-MM-DD`;
 * lo calcula el use-case con la zona de la sede). Vacía → null.
 */
export function validateClinicalDate(
  iso: string | null | undefined,
  today: string,
): string | null {
  const value = (iso ?? '').trim();
  if (value === '') return null;
  const m = ISO_DATE.exec(value);
  if (!m) throw new PatientDocumentRuleError('La fecha clínica no es válida.');
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new PatientDocumentRuleError('La fecha clínica no es válida.');
  }
  // Mismo formato de ancho fijo: la comparación de cadenas es cronológica.
  if (value > today) {
    throw new PatientDocumentRuleError('La fecha clínica no puede ser futura.');
  }
  return value;
}

export const CONTROL_CHARS_MESSAGE =
  'El texto contiene caracteres no permitidos.';

/**
 * Controles C0/C1 salvo tabulador, salto de línea y retorno de carro (un
 * textarea en un multipart llega con CRLF). Postgres rechaza 0x00 en `text`
 * (sería un 500) y el resto no tiene sentido en un texto clínico. Se rechaza
 * en vez de quitarlo: no se cambia en silencio lo que escribió el usuario.
 */
const FORBIDDEN_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex -- detectar controles es justo lo que se quiere
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function assertNoControlChars(value: string): void {
  if (FORBIDDEN_CONTROL_CHARS.test(value)) {
    throw new PatientDocumentRuleError(CONTROL_CHARS_MESSAGE);
  }
}

/**
 * Notas opcionales: como mucho 500 caracteres (puntos de código) tras
 * recortar, sin caracteres de control (salvo tabulador y saltos de línea);
 * vacías → null.
 */
export function validateNotes(notes: string | null | undefined): string | null {
  const trimmed = (notes ?? '').trim();
  if (trimmed === '') return null;
  assertNoControlChars(trimmed);
  if (codePoints(trimmed) > MAX_NOTES_LENGTH) {
    throw new PatientDocumentRuleError(
      'Las notas admiten hasta 500 caracteres.',
    );
  }
  return trimmed;
}

/**
 * Motivo de anulación: 3..500 caracteres tras recortar, en puntos de código
 * como el CHECK `char_length(btrim("voidReason"))` (si no, «🦷🦷» pasaría
 * aquí y la BD daría un 500), y sin caracteres de control (como las notas).
 */
export function validateVoidReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
  assertNoControlChars(trimmed);
  const length = codePoints(trimmed);
  if (length < 3 || length > MAX_VOID_REASON_LENGTH) {
    throw new PatientDocumentRuleError(
      'El motivo debe tener entre 3 y 500 caracteres.',
    );
  }
  return trimmed;
}

/** SHA-256 del contenido en hex minúsculas (CHECK `^[0-9a-f]{64}$`). */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const INVALID_SHA256_MESSAGE =
  'La huella SHA-256 del archivo no es válida.';

/**
 * Huella que declara el cliente al pedir la subida directa (DX-259): 64
 * dígitos hex (se normaliza a minúsculas). El almacén rechaza un contenido
 * con otra huella, y `complete` la vuelve a comprobar.
 */
export function validateSha256Hex(value: unknown): string {
  if (isSha256Hex(value)) {
    return value.trim().toLowerCase();
  }
  throw new PatientDocumentRuleError(INVALID_SHA256_MESSAGE);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Clave en el almacén: `patient-documents/<tenantId>/<documentId>.<ext>`.
 * Solo ids y la extensión del tipo DETECTADO: nada del nombre original (PII)
 * ni del cliente. Ids que no son uuid son un error de programación.
 */
export function storageKeyFor(
  tenantId: string,
  documentId: string,
  type: DetectedType,
  sha256?: string,
): string {
  if (!UUID.test(tenantId) || !UUID.test(documentId)) {
    throw new Error('storageKeyFor: tenantId y documentId deben ser uuid');
  }
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('storageKeyFor: sha256 debe ser hex de 64');
  }
  // DX-259: con la huella (subida directa), `<id>-<16 hex>`: dos `complete`
  // a la vez del mismo id con contenidos distintos no pisan el mismo objeto.
  const name = sha256 ? `${documentId}-${sha256.slice(0, 16)}` : documentId;
  return `patient-documents/${tenantId}/${name}.${extensionOf(type)}`;
}

/**
 * DX-259: clave donde el navegador deja el fichero antes de `complete`:
 * `patient-documents/pending/<tenantId>/<documentId>`. La API no la sirve
 * nunca; un objeto que se queda aquí lo borra el ciclo de vida del bucket a
 * las 24 h (README, «Subida directa al bucket»).
 */
export function pendingStorageKeyFor(
  tenantId: string,
  documentId: string,
): string {
  if (!UUID.test(tenantId) || !UUID.test(documentId)) {
    throw new Error(
      'pendingStorageKeyFor: tenantId y documentId deben ser uuid',
    );
  }
  return `patient-documents/pending/${tenantId}/${documentId}`;
}
