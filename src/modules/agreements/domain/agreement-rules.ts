import { AgreementKind } from '@prisma/client';
import { parseCivilDate } from '../../../shared/time/civil-day';

/**
 * Reglas de un convenio (DX-105). Puras: las comparten el caso de uso (400 en
 * español), el DTO y los tests; la migración repite la forma por `kind`, el
 * rango del porcentaje y la vigencia como CHECK, que es la red si algo se
 * saltara la API.
 */
export const AGREEMENT_NAME_MIN = 2;
export const AGREEMENT_NAME_MAX = 120;
/** Claves de `percentByCategory` y su largo. */
export const PERCENT_BY_CATEGORY_MAX_KEYS = 50;
export const CATEGORY_KEY_MAX = 80;
export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;

export const AGREEMENT_NAME_MESSAGE = `El nombre debe tener entre ${AGREEMENT_NAME_MIN} y ${AGREEMENT_NAME_MAX} caracteres.`;
export const AGREEMENT_PERCENT_REQUIRED_MESSAGE =
  'Indica el porcentaje del convenio.';
export const AGREEMENT_PRICE_LIST_REQUIRED_MESSAGE =
  'Indica la lista de precios del convenio.';
export const AGREEMENT_PERCENT_RANGE_MESSAGE =
  'El porcentaje debe estar entre 0 y 100.';
export const AGREEMENT_PERCENT_FORBIDDEN_MESSAGE =
  'Un convenio con lista de precios no lleva porcentaje.';
export const AGREEMENT_PRICE_LIST_FORBIDDEN_MESSAGE =
  'Un convenio con descuento porcentual no lleva lista de precios.';
export const AGREEMENT_PERCENT_BY_CATEGORY_MESSAGE = `Los porcentajes por categoría deben ser un objeto de hasta ${PERCENT_BY_CATEGORY_MAX_KEYS} categorías, con porcentajes entre 0 y 100 y hasta 2 decimales.`;
export const AGREEMENT_DATE_FORMAT_MESSAGE =
  'La fecha debe tener el formato AAAA-MM-DD.';
export const AGREEMENT_DATE_RANGE_MESSAGE =
  'La fecha de fin no puede ser anterior a la de inicio.';

export const AGREEMENT_NOT_FOUND_MESSAGE = 'Convenio no encontrado.';
export const AGREEMENT_DUPLICATE_MESSAGE =
  'Ya existe un convenio con ese nombre.';
export const AGREEMENT_IN_USE_MESSAGE =
  'Este convenio tiene pacientes asignados; desactívalo en lugar de retirarlo.';
export const AGREEMENT_PAYER_NOT_FOUND_MESSAGE = 'Pagador no encontrado.';
export const AGREEMENT_PAYER_INACTIVE_MESSAGE = 'Ese pagador está desactivado.';
export const AGREEMENT_PRICE_LIST_NOT_FOUND_MESSAGE =
  'Lista de precios no encontrada.';
export const AGREEMENT_PRICE_LIST_INACTIVE_MESSAGE =
  'Esa lista de precios está desactivada.';
export const AGREEMENT_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada.';

export function categoryUnknownMessage(category: string): string {
  return `La categoría «${category}» no existe en el catálogo.`;
}

export function categoryRepeatedMessage(category: string): string {
  return `La categoría «${category}» está repetida.`;
}

/** Espacios de los extremos fuera y los internos colapsados a uno. */
export function normalizeAgreementName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Clave de comparación de un texto: minúsculas, sin tildes, sin espacios de
 * más. Misma regla que `public.dx_search_normalize` en Postgres.
 */
export function agreementNameKey(name: string): string {
  return normalizeAgreementName(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Clave de una categoría del catálogo (misma regla que el nombre). */
export function normalizeCategory(category: string): string {
  return agreementNameKey(category);
}

export function validateAgreementName(name: string): string | null {
  const length = normalizeAgreementName(name).length;
  return length >= AGREEMENT_NAME_MIN && length <= AGREEMENT_NAME_MAX
    ? null
    : AGREEMENT_NAME_MESSAGE;
}

export function isValidPercent(value: number): boolean {
  return Number.isFinite(value) && value >= PERCENT_MIN && value <= PERCENT_MAX;
}

export interface AgreementShape {
  kind: AgreementKind;
  percent: number | null;
  percentByCategory: Record<string, number> | null;
  priceListId: string | null;
}

/**
 * Forma del convenio según su `kind` (la misma que el CHECK de la BD):
 * `PERCENT_DISCOUNT` pide `percent` y no lleva lista; `PRICE_LIST` pide lista
 * y no lleva porcentajes. Devuelve el mensaje en español o `null`.
 */
export function validateAgreementShape(s: AgreementShape): string | null {
  if (s.kind === AgreementKind.PERCENT_DISCOUNT) {
    if (s.priceListId !== null) return AGREEMENT_PRICE_LIST_FORBIDDEN_MESSAGE;
    if (s.percent === null) return AGREEMENT_PERCENT_REQUIRED_MESSAGE;
    return isValidPercent(s.percent) ? null : AGREEMENT_PERCENT_RANGE_MESSAGE;
  }
  if (s.priceListId === null) return AGREEMENT_PRICE_LIST_REQUIRED_MESSAGE;
  if (s.percent !== null || s.percentByCategory !== null) {
    return AGREEMENT_PERCENT_FORBIDDEN_MESSAGE;
  }
  return null;
}

/**
 * Cruza las claves de `percentByCategory` con las categorías del catálogo
 * (`catalogCategories`, texto libre tal como está en el catálogo) comparando
 * normalizado. Devuelve el mapa con la ortografía ORIGINAL de la categoría del
 * catálogo, o el mensaje del primer fallo: categoría inexistente, porcentaje
 * fuera de rango o dos claves que son la misma categoría.
 */
export function matchCategories(
  percentByCategory: Record<string, number>,
  catalogCategories: string[],
): { value: Record<string, number>; error: null } | { error: string } {
  const spelling = new Map<string, string>();
  for (const category of catalogCategories) {
    const key = normalizeCategory(category);
    if (key !== '' && !spelling.has(key)) spelling.set(key, category.trim());
  }
  const value: Record<string, number> = {};
  for (const [rawKey, percent] of Object.entries(percentByCategory)) {
    const original = spelling.get(normalizeCategory(rawKey));
    if (original === undefined) {
      return { error: categoryUnknownMessage(rawKey.trim()) };
    }
    if (!isValidPercent(percent))
      return { error: AGREEMENT_PERCENT_RANGE_MESSAGE };
    if (Object.prototype.hasOwnProperty.call(value, original)) {
      return { error: categoryRepeatedMessage(original) };
    }
    value[original] = percent;
  }
  return { value, error: null };
}

/** Formato `YYYY-MM-DD` real y `validTo >= validFrom`. */
export function validateAgreementDates(
  from: string | null,
  to: string | null,
): string | null {
  for (const value of [from, to]) {
    if (value !== null && parseCivilDate(value) === null) {
      return AGREEMENT_DATE_FORMAT_MESSAGE;
    }
  }
  if (from !== null && to !== null && to < from) {
    return AGREEMENT_DATE_RANGE_MESSAGE;
  }
  return null;
}

export type AgreementStatus = 'ACTIVE' | 'EXPIRED' | 'NOT_STARTED' | 'INACTIVE';

/**
 * Estado a un día civil (`today` = `YYYY-MM-DD`). `INACTIVE` va primero: un
 * convenio desactivado o retirado no aplica aunque su vigencia lo cubra. Luego
 * `EXPIRED` si `validTo < hoy`, `NOT_STARTED` si `validFrom > hoy` y `ACTIVE`
 * el resto (vigencia indefinida incluida; los extremos cuentan como vigentes).
 */
export function agreementStatus(
  a: {
    active: boolean;
    retired?: boolean;
    validFrom: string | null;
    validTo: string | null;
  },
  today: string,
): AgreementStatus {
  if (!a.active || a.retired === true) return 'INACTIVE';
  if (a.validTo !== null && a.validTo < today) return 'EXPIRED';
  if (a.validFrom !== null && a.validFrom > today) return 'NOT_STARTED';
  return 'ACTIVE';
}
