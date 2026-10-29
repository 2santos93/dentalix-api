/**
 * Reglas de un pagador (DX-153). Puras: las comparten el caso de uso (400 en
 * español) y los tests. El tipo y `isExternalPayer` viven en `payer-type.ts`.
 */
export const PAYER_NAME_MIN = 2;
export const PAYER_NAME_MAX = 120;

export const PAYER_NAME_MESSAGE = `El nombre debe tener entre ${PAYER_NAME_MIN} y ${PAYER_NAME_MAX} caracteres.`;

/** Espacios de los extremos fuera y los internos colapsados a uno. */
export function normalizePayerName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Clave de comparación del nombre: minúsculas, sin tildes, sin espacios de más.
 * Misma regla que `public.dx_search_normalize` en Postgres.
 */
export function payerNameKey(name: string): string {
  return normalizePayerName(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

export function validatePayerName(name: string): string | null {
  const length = normalizePayerName(name).length;
  return length >= PAYER_NAME_MIN && length <= PAYER_NAME_MAX
    ? null
    : PAYER_NAME_MESSAGE;
}
