/**
 * Códigos de salud de Colombia que pide el RDA (Res. 1888/2025) y el RIPS
 * (DX-212): CUPS de los procedimientos, código de habilitación REPS de la sede
 * y CIE-10 de los diagnósticos. Funciones puras, compartidas por los casos de
 * uso del catálogo, de las sedes y de las evoluciones.
 */

/** CUPS: 6 caracteres alfanuméricos (p. ej. 890203, consulta de odontología). */
export const CUPS_PATTERN = /^[A-Z0-9]{6}$/;
/** REPS: código de habilitación de 12 dígitos (prestador + sede). */
export const REPS_PATTERN = /^\d{12}$/;
/** CIE-10: letra, 2 dígitos y, opcional, punto y 1–2 caracteres (K02.1). */
export const ICD10_PATTERN = /^[A-Z]\d{2}(\.[0-9A-Z]{1,2})?$/;

export const CUPS_FORMAT_MESSAGE =
  'El código CUPS debe tener 6 caracteres alfanuméricos (p. ej. 890203)';
export const REPS_FORMAT_MESSAGE =
  'El código de habilitación REPS debe tener 12 dígitos (p. ej. 110010123401)';
export const ICD10_INVALID_MESSAGE = 'Código CIE-10 no válido';

/**
 * Quita espacios y pasa a mayúsculas. Cadena vacía = `null` (quitar el
 * código); `undefined` = el campo no venía (no se toca).
 */
export function normalizeCupsCode(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const value = raw.trim().toUpperCase();
  return value === '' ? null : value;
}

export function isValidCupsCode(code: string): boolean {
  return CUPS_PATTERN.test(code);
}

/** Igual que `normalizeCupsCode`, sin cambiar mayúsculas (son dígitos). */
export function normalizeRepsCode(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

export function isValidRepsCode(code: string): boolean {
  return REPS_PATTERN.test(code);
}

/**
 * Mayúsculas, sin espacios y con el punto si falta: «k021» → «K02.1» (el
 * RIPS los escribe sin punto; la tabla de referencia, con él).
 */
export function normalizeIcd10Code(raw: string): string {
  const value = raw.trim().toUpperCase();
  const withoutDot = /^([A-Z]\d{2})([0-9A-Z]{1,2})$/.exec(value);
  return withoutDot ? `${withoutDot[1]}.${withoutDot[2]}` : value;
}

export function isValidIcd10Format(code: string): boolean {
  return ICD10_PATTERN.test(code);
}
