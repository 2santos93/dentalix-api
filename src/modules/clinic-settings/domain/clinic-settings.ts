/**
 * DX-019: los datos de la clínica que edita el ADMIN en Ajustes › Datos de la
 * clínica — nombre comercial, datos fiscales, contacto, color y logo.
 *
 * Producto mundial: el identificador fiscal es TEXTO LIBRE (sin validar el
 * formato de ningún país) y la clínica decide cómo se llama («ID fiscal»,
 * …). Ningún valor por defecto nombra un país: sin datos, `null`.
 */

/** Topes (los mismos CHECK en la BD, migración 20261114100000). */
export const CLINIC_NAME_MAX = 120;
export const LEGAL_NAME_MAX = 160;
export const TAX_ID_MAX = 64;
export const TAX_ID_LABEL_MAX = 40;
/** Cabe entera en el antes y el después de la auditoría (tope 255). */
export const FISCAL_ADDRESS_MAX = 250;
export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_PHONE_MAX = 40;

/** Lo que guarda la clínica (`null` = sin dato). */
export interface ClinicProfile {
  name: string;
  legalName: string | null;
  taxId: string | null;
  taxIdLabel: string | null;
  fiscalAddress: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** `#RRGGBB` en mayúsculas (lo que lee la web para derivar el acento). */
  primaryColor: string;
}

/** Lo que devuelve GET /clinic/settings. */
export interface ClinicSettingsView extends ClinicProfile {
  /** URL pública del logo, o `null`. */
  logoUrl: string | null;
  /** Falta la razón social o el identificador: los recibos dirán «Datos fiscales pendientes». */
  fiscalDataPending: boolean;
}

/** Un cambio parcial: un campo ausente no cambia; `null` o vacío lo borra. */
export type ClinicProfilePatch = Partial<ClinicProfile>;

export interface ClinicProfileInput {
  name?: string | null;
  legalName?: string | null;
  taxId?: string | null;
  taxIdLabel?: string | null;
  fiscalAddress?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  primaryColor?: string | null;
}

export const CLINIC_SETTINGS_MESSAGES = {
  name: `El nombre comercial es obligatorio y admite hasta ${CLINIC_NAME_MAX} caracteres en una línea.`,
  legalName: `La razón social admite hasta ${LEGAL_NAME_MAX} caracteres en una línea.`,
  taxId: `El identificador fiscal admite hasta ${TAX_ID_MAX} caracteres en una línea.`,
  taxIdLabel: `El nombre del identificador fiscal admite hasta ${TAX_ID_LABEL_MAX} caracteres en una línea.`,
  fiscalAddress: `La dirección fiscal admite hasta ${FISCAL_ADDRESS_MAX} caracteres en una línea.`,
  contactEmail:
    'El email de contacto no es válido (nombre@dominio, sin espacios).',
  contactPhone: `El teléfono de contacto admite hasta ${CONTACT_PHONE_MAX} caracteres en una línea.`,
  primaryColor:
    'El color debe ser un hexadecimal de seis cifras, p. ej. #0E7490.',
} as const;

// Controles, separadores de línea y de párrafo: el texto va en UNA línea.
const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;
const HEX6 = /^#[0-9a-f]{6}$/i;
// Deliberadamente laxo: la clínica puede tener un dominio interno o con
// caracteres no ASCII; lo que se pide es la forma `algo@algo` sin espacios.
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

/** Recortado, `null` si queda vacío; `undefined` si no cabe o no es una línea. */
function oneLine(
  value: string | null | undefined,
  max: number,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (NOT_ONE_LINE.test(trimmed) || [...trimmed].length > max) return undefined;
  return trimmed;
}

export type ParsedClinicProfile =
  { ok: true; patch: ClinicProfilePatch } | { ok: false; message: string };

const TEXT_FIELDS = [
  ['legalName', LEGAL_NAME_MAX],
  ['taxId', TAX_ID_MAX],
  ['taxIdLabel', TAX_ID_LABEL_MAX],
  ['fiscalAddress', FISCAL_ADDRESS_MAX],
  ['contactPhone', CONTACT_PHONE_MAX],
] as const;

/**
 * Valida y normaliza un PATCH. Solo entran los campos presentes (`in`): uno
 * ausente no cambia. El nombre y el color no se pueden borrar.
 */
export function parseClinicProfilePatch(
  input: ClinicProfileInput,
): ParsedClinicProfile {
  const patch: ClinicProfilePatch = {};
  if ('name' in input && input.name !== undefined) {
    const name = oneLine(input.name, CLINIC_NAME_MAX);
    if (!name) return { ok: false, message: CLINIC_SETTINGS_MESSAGES.name };
    patch.name = name;
  }
  for (const [field, max] of TEXT_FIELDS) {
    if (!(field in input) || input[field] === undefined) continue;
    const value = oneLine(input[field], max);
    if (value === undefined)
      return { ok: false, message: CLINIC_SETTINGS_MESSAGES[field] };
    patch[field] = value;
  }
  if ('contactEmail' in input && input.contactEmail !== undefined) {
    const email = oneLine(input.contactEmail, CONTACT_EMAIL_MAX);
    if (
      email === undefined ||
      (email !== null && (email.length < 3 || !EMAIL.test(email)))
    ) {
      return { ok: false, message: CLINIC_SETTINGS_MESSAGES.contactEmail };
    }
    patch.contactEmail = email;
  }
  if ('primaryColor' in input && input.primaryColor !== undefined) {
    const color = input.primaryColor?.trim() ?? '';
    if (!HEX6.test(color))
      return { ok: false, message: CLINIC_SETTINGS_MESSAGES.primaryColor };
    patch.primaryColor = color.toUpperCase();
  }
  return { ok: true, patch };
}

/** Sin razón social o sin identificador fiscal, los datos fiscales están pendientes. */
export function isFiscalDataPending(
  profile: Pick<ClinicProfile, 'legalName' | 'taxId'>,
): boolean {
  return !profile.legalName?.trim() || !profile.taxId?.trim();
}

/** Los campos tal como entran en la auditoría (antes y después). */
export function clinicProfileForAudit(
  profile: ClinicProfile,
): Record<string, string | null> {
  return {
    name: profile.name,
    legalName: profile.legalName,
    taxId: profile.taxId,
    taxIdLabel: profile.taxIdLabel,
    fiscalAddress: profile.fiscalAddress,
    contactEmail: profile.contactEmail,
    contactPhone: profile.contactPhone,
    primaryColor: profile.primaryColor,
  };
}
