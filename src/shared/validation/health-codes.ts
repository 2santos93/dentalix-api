/**
 * Códigos de salud (DX-212): código de habilitación REPS de la sede y CIE-10
 * de los diagnósticos. Funciones puras, compartidas por los casos de uso de
 * las sedes y de las evoluciones.
 */

/** REPS: código de habilitación de 12 dígitos (prestador + sede). */
export const REPS_PATTERN = /^\d{12}$/;
/** CIE-10: letra, 2 dígitos y, opcional, punto y 1–2 caracteres (K02.1). */
export const ICD10_PATTERN = /^[A-Z]\d{2}(\.[0-9A-Z]{1,2})?$/;

export const REPS_FORMAT_MESSAGE =
  'El código de habilitación REPS debe tener 12 dígitos (p. ej. 110010123401)';
export const ICD10_INVALID_MESSAGE = 'Código CIE-10 no válido';

/**
 * Quita espacios. Cadena vacía = `null` (quitar el código); `undefined` = el
 * campo no venía (no se toca).
 */
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
 * Mayúsculas, sin espacios y con el punto si falta: «k021» → «K02.1» (hay
 * sistemas que los escriben sin punto; la tabla de referencia, con él).
 */
export function normalizeIcd10Code(raw: string): string {
  const value = raw.trim().toUpperCase();
  const withoutDot = /^([A-Z]\d{2})([0-9A-Z]{1,2})$/.exec(value);
  return withoutDot ? `${withoutDot[1]}.${withoutDot[2]}` : value;
}

export function isValidIcd10Format(code: string): boolean {
  return ICD10_PATTERN.test(code);
}
