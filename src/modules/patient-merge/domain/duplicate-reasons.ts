/**
 * DX-266: por qué una pareja sale en «Posibles duplicados».
 *
 * - `DOCUMENT`: el mismo documento normalizado (solo letras y dígitos, en
 *   mayúsculas: «V-12.345.678» = «v12345678», la clave de DX-287).
 * - `NAME_BIRTHDATE`: el mismo nombre completo (sin tildes, mayúsculas ni
 *   espacios de más) y la misma fecha de nacimiento.
 * - `PHONE_NAME`: el mismo teléfono (sus 8 últimos dígitos, DX-225) y el
 *   mismo primer nombre y primer apellido: en una familia que comparte
 *   teléfono, el nombre de pila los separa.
 */
export const DUPLICATE_REASONS = [
  'DOCUMENT',
  'NAME_BIRTHDATE',
  'PHONE_NAME',
] as const;

export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

/**
 * Un grupo con más pacientes que esto (un teléfono de la clínica puesto a
 * todos, un documento de relleno) no es un duplicado: no se emparejan.
 */
export const MAX_DUPLICATE_GROUP_SIZE = 10;

/** Página de la lista de parejas. */
export const DUPLICATES_MAX_PAGE_SIZE = 50;
export const DUPLICATES_DEFAULT_PAGE_SIZE = 20;
export const DUPLICATES_MAX_PAGE = 100;

/** La pareja siempre en el mismo orden (como la guarda la BD: A < B). */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
