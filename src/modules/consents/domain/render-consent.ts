/**
 * Variables que admite el texto de una plantilla de consentimiento (DX-006).
 * Se escriben `{{nombre}}`; dentro de las llaves se toleran espacios y
 * mayúsculas (`{{ Paciente }}`).
 */
export const CONSENT_VARIABLES = [
  'paciente',
  'documento',
  'profesional',
  'clinica',
  'fecha',
  'tratamiento',
] as const;

export type ConsentVariable = (typeof CONSENT_VARIABLES)[number];
export type ConsentVariables = Record<ConsentVariable, string>;

const KNOWN: ReadonlySet<string> = new Set(CONSENT_VARIABLES);
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

function isKnown(name: string): name is ConsentVariable {
  return KNOWN.has(name);
}

/**
 * Sustituye las variables en UNA pasada: el valor de una variable nunca se
 * vuelve a interpretar como plantilla (un paciente llamado "{{clinica}}" sale
 * tal cual). Una variable desconocida se deja literal; el alta/edición de la
 * plantilla ya la rechaza con `findUnknownVariables`.
 */
export function renderConsent(body: string, values: ConsentVariables): string {
  return body.replace(VARIABLE_PATTERN, (match, raw: string) => {
    const name = raw.toLowerCase();
    return isKnown(name) ? values[name] : match;
  });
}

/** Variables del texto que no existen (en minúscula, sin repetir, en orden). */
export function findUnknownVariables(body: string): string[] {
  const unknown = new Set<string>();
  for (const [, raw] of body.matchAll(VARIABLE_PATTERN)) {
    const name = raw.toLowerCase();
    if (!isKnown(name)) unknown.add(name);
  }
  return [...unknown];
}

/** «16 de octubre de 2026», en la zona horaria de la clínica. */
export function formatConsentDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(date);
}
