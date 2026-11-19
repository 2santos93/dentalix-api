import type { PatientSourceKind } from '@prisma/client';

/**
 * DX-172: una fuente de captación del catálogo de la clínica («¿Cómo nos
 * conoció?»). No se borra: se desactiva, y los pacientes que la tienen la
 * conservan (también en el informe).
 */
export interface PatientSourceEntity {
  id: string;
  name: string;
  kind: PatientSourceKind;
  isActive: boolean;
  /** Clave de las sembradas (PATIENT_REFERRAL, INSTAGRAM…); null en las propias. */
  systemKey: string | null;
  sortOrder: number;
}

export const PATIENT_SOURCE_KINDS: readonly PatientSourceKind[] = [
  'CHANNEL',
  'PATIENT',
  'EXTERNAL_PROFESSIONAL',
];

export const PATIENT_SOURCE_NAME_MIN = 2;
export const PATIENT_SOURCE_NAME_MAX = 60;
/** Las propias van detrás de las sembradas (10…90). */
export const CUSTOM_SOURCE_SORT_ORDER = 100;

export const PATIENT_SOURCE_MESSAGES = {
  notFound: 'Fuente no encontrada.',
  nameTaken: 'Ya existe una fuente con ese nombre.',
  nameLength: `El nombre debe tener entre ${PATIENT_SOURCE_NAME_MIN} y ${PATIENT_SOURCE_NAME_MAX} caracteres.`,
  adminOnly: 'Solo la administración cambia el origen de pacientes.',
} as const;

/** Recortado y con los espacios internos colapsados; null si no vale. */
export function cleanSourceName(value: string): string | null {
  const clean = value.replace(/\s+/g, ' ').trim();
  const length = [...clean].length;
  return length >= PATIENT_SOURCE_NAME_MIN && length <= PATIENT_SOURCE_NAME_MAX
    ? clean
    : null;
}

/**
 * Prospectos (DX-556): la fuente que se le pone al paciente que CREA la
 * conversión, cuando el canal del prospecto tiene una correspondencia
 * evidente con una fuente sembrada. WhatsApp, teléfono y web son el medio por
 * el que escribió, no cómo nos conoció: sin fuente.
 */
export const LEAD_CHANNEL_SOURCE_KEY: Readonly<Record<string, string | null>> =
  {
    INSTAGRAM: 'INSTAGRAM',
    FACEBOOK: 'FACEBOOK',
    WALK_IN: 'WALK_IN',
    REFERRAL: 'PATIENT_REFERRAL',
    OTHER: 'OTHER',
    WHATSAPP: null,
    PHONE: null,
    WEBSITE: null,
  };
