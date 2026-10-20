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
 * Controles C0/C1 y caracteres de formato que disfrazan un nombre (marcas y
 * overrides bidi, ancho cero): `foto<U+202E>gnp.exe` se ve como «fotoexe.png».
 */
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex -- quitar controles es justo lo que se quiere
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
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

/** Dientes FDI (0..8, sin repetir), recortados. */
export function validateToothNumbers(
  list: readonly string[] | null | undefined,
): string[] {
  const teeth = (list ?? []).map((t) => t.trim());
  if (teeth.length > MAX_TOOTH_NUMBERS) {
    throw new PatientDocumentRuleError('Como mucho 8 dientes por documento.');
  }
  const seen = new Set<string>();
  for (const tooth of teeth) {
    if (!FDI_TOOTH_NUMBER_PATTERN.test(tooth)) {
      throw new PatientDocumentRuleError(
        `El diente «${tooth}» no es un número FDI válido.`,
      );
    }
    if (seen.has(tooth)) {
      throw new PatientDocumentRuleError(`El diente «${tooth}» está repetido.`);
    }
    seen.add(tooth);
  }
  return teeth;
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

/** Motivo de anulación: 3..500 caracteres tras recortar (CHECK de la BD). */
export function validateVoidReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
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
