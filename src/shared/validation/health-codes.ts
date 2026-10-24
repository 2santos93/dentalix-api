/**
 * Códigos de salud (DX-212): CIE-10 de los diagnósticos. Funciones puras,
 * compartidas por los casos de uso de las evoluciones. DX-319: el código REPS
 * de la sede se borró (DX-320 borró el CUPS).
 */

/** CIE-10: letra, 2 dígitos y, opcional, punto y 1–2 caracteres (K02.1). */
export const ICD10_PATTERN = /^[A-Z]\d{2}(\.[0-9A-Z]{1,2})?$/;

export const ICD10_INVALID_MESSAGE = 'Código CIE-10 no válido';

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
