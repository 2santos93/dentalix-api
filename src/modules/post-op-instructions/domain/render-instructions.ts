/**
 * Variables que admite el texto de una plantilla de indicaciones
 * postoperatorias (DX-222). Se escriben `{{nombre}}`; dentro de las llaves se
 * toleran espacios y mayúsculas (`{{ Paciente }}`).
 */
export const POSTOP_VARIABLES = [
  'paciente',
  'profesional',
  'clinica',
  'telefono_sede',
  'fecha',
] as const;

export type PostOpVariable = (typeof POSTOP_VARIABLES)[number];
export type PostOpVariables = Record<PostOpVariable, string>;

const KNOWN: ReadonlySet<string> = new Set(POSTOP_VARIABLES);
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

function isKnown(name: string): name is PostOpVariable {
  return KNOWN.has(name);
}

/**
 * Sustituye las variables en UNA pasada: el valor de una variable nunca se
 * vuelve a interpretar como plantilla. Una variable sin valor sale como cadena
 * vacía; una desconocida se deja literal (el alta de la plantilla ya la
 * rechaza con `unknownVariables`).
 */
export function renderInstructions(
  body: string,
  vars: PostOpVariables,
): string {
  return body.replace(VARIABLE_PATTERN, (match, raw: string) => {
    const name = raw.toLowerCase();
    return isKnown(name) ? (vars[name] ?? '') : match;
  });
}

/** Variables del texto que no existen (en minúscula, sin repetir, en orden). */
export function unknownVariables(body: string): string[] {
  const unknown = new Set<string>();
  for (const [, raw] of body.matchAll(VARIABLE_PATTERN)) {
    const name = raw.toLowerCase();
    if (!isKnown(name)) unknown.add(name);
  }
  return [...unknown];
}
