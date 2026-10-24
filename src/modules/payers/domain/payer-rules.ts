import { ClinicCountry, PayerType } from '@prisma/client';

/**
 * Reglas de un pagador (DX-153). Puras: las comparten el caso de uso (400 en
 * español) y los tests; la migración repite tipo/país como CHECK, que es la
 * red si algo se saltara la API.
 */
export const PAYER_NAME_MIN = 2;
export const PAYER_NAME_MAX = 120;

export const PAYER_NAME_MESSAGE = `El nombre debe tener entre ${PAYER_NAME_MIN} y ${PAYER_NAME_MAX} caracteres.`;
export const PAYER_TYPE_COUNTRY_MESSAGE =
  'El tipo de pagador no corresponde con el país.';

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

/**
 * `MUTUA_ES` exige ES; `PREPAGADA_CO` y `EPS_CO` exigen CO; `EMPRESA` y
 * `OTRO` admiten cualquier país o ninguno.
 */
export function validatePayerTypeCountry(
  type: PayerType,
  country: ClinicCountry | null | undefined,
): string | null {
  const required: ClinicCountry | null =
    type === PayerType.MUTUA_ES
      ? ClinicCountry.ES
      : type === PayerType.PREPAGADA_CO || type === PayerType.EPS_CO
        ? ClinicCountry.CO
        : null;
  if (required === null) return null;
  return country === required ? null : PAYER_TYPE_COUNTRY_MESSAGE;
}

/**
 * SEC-047: ¿es un pagador externo real? `OTRO` («Otro / sin clasificar») es el
 * de los convenios internos —cortesía, empleados, socios—, que nadie de fuera
 * respalda; el resto de tipos sí. SEC-049: una
 * cobertura de un pagador externo lleva nº de afiliado obligatorio.
 */
export function isExternalPayer(type: PayerType): boolean {
  return type !== 'OTRO';
}
