import { createHash } from 'node:crypto';
import { FDI_TOOTH_NUMBER_PATTERN } from '../../odontogram/application/use-cases/add-tooth-record.use-case';
import { type DetectedType, extensionOf } from './document-content';
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

export const MAX_ORIGINAL_NAME_LENGTH = 255;
export const MAX_TOOTH_NUMBERS = 8;
export const MAX_NOTES_LENGTH = 500;
export const MAX_VOID_REASON_LENGTH = 500;

/**
 * Longitud en puntos de código, como `char_length` de Postgres (los CHECK de
 * la BD): un emoji cuenta 1, no 2 unidades UTF-16.
 */
const codePoints = (value: string): number => Array.from(value).length;
export const FALLBACK_ORIGINAL_NAME = 'documento';

/** Mismo orden y valores que el enum `PatientDocumentCategory` de la BD. */
export const PATIENT_DOCUMENT_CATEGORIES: readonly PatientDocumentCategory[] = [
  'XRAY',
  'PHOTO',
  'REFERRAL',
  'SIGNED_CONSENT',
  'REPORT',
  'OTHER',
];

/**
 * Controles (Cc), caracteres de formato (Cf: marcas y overrides bidi, ancho
 * cero, U+061C, U+2060-2064, BOM, …) y separadores de línea y párrafo
 * (U+2028/U+2029): `foto<U+202E>gnp.exe` se ve como «fotoexe.png».
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const EXTENSION = /\.[^.]{1,16}$/;

/**
 * Nombre original SOLO para mostrar (la clave del almacén no lo usa): sin
 * controles, sin componentes de ruta (`/` ni `\`), recortado y con como mucho
 * 255 caracteres (puntos de código) conservando la extensión. Si no queda
 * nada útil, «documento».
 */
export function normalizeOriginalName(name: string): string {
  const clean = name.replace(UNSAFE_CHARS, '');
  const base = (clean.split(/[/\\]/).pop() ?? '').trim();
  if (base === '' || /^\.+$/.test(base)) return FALLBACK_ORIGINAL_NAME;

  const chars = Array.from(base);
  if (chars.length <= MAX_ORIGINAL_NAME_LENGTH) return base;
  const ext = EXTENSION.exec(base)?.[0] ?? '';
  const keep = MAX_ORIGINAL_NAME_LENGTH - Array.from(ext).length;
  return chars.slice(0, keep).join('') + ext;
}

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

/**
 * Notas opcionales: como mucho 500 caracteres (puntos de código) tras
 * recortar; vacías → null.
 */
export function validateNotes(notes: string | null | undefined): string | null {
  const trimmed = (notes ?? '').trim();
  if (trimmed === '') return null;
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
 * aquí y la BD daría un 500).
 */
export function validateVoidReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
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
): string {
  if (!UUID.test(tenantId) || !UUID.test(documentId)) {
    throw new Error('storageKeyFor: tenantId y documentId deben ser uuid');
  }
  return `patient-documents/${tenantId}/${documentId}.${extensionOf(type)}`;
}
