/**
 * Reglas de una lista de precios (DX-105). Puras: las comparten el caso de uso
 * (400 en español), el DTO y los tests; la migración repite el largo del
 * nombre y `price >= 0` como CHECK, que es la red si algo se saltara la API.
 */
export const PRICE_LIST_NAME_MIN = 2;
export const PRICE_LIST_NAME_MAX = 120;
/** Filas por `PUT /price-lists/:id/items`. */
export const PRICE_LIST_ITEMS_MAX = 500;

export const PRICE_LIST_NAME_MESSAGE = `El nombre debe tener entre ${PRICE_LIST_NAME_MIN} y ${PRICE_LIST_NAME_MAX} caracteres.`;

export const PRICE_LIST_NOT_FOUND_MESSAGE = 'Lista de precios no encontrada.';
export const PRICE_LIST_DUPLICATE_MESSAGE =
  'Ya existe una lista de precios con ese nombre.';
export const PRICE_LIST_LOCATION_TAKEN_MESSAGE =
  'Esa sede ya tiene una lista de precios activa.';
export const PRICE_LIST_CURRENCY_LOCKED_MESSAGE =
  'La lista tiene precios; crea una lista nueva para otra moneda.';
export const PRICE_LIST_IN_USE_MESSAGE =
  'Esta lista la usa un convenio; desactívala en lugar de retirarla.';
export const PRICE_LIST_CURRENCY_UNKNOWN_MESSAGE = 'Moneda no válida.';
export const PRICE_LIST_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada.';
export const PRICE_LIST_CATALOG_ITEMS_MESSAGE =
  'Hay prestaciones que no existen en el catálogo de esta clínica.';
export const PRICE_LIST_NOT_PRICEABLE_MESSAGE =
  'Solo se pueden fijar precios de procedimientos activos.';
export const PRICE_LIST_DUPLICATED_ITEMS_MESSAGE =
  'Una prestación aparece más de una vez en el lote.';

/** Espacios de los extremos fuera y los internos colapsados a uno. */
export function normalizePriceListName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Clave de comparación del nombre: minúsculas, sin tildes, sin espacios de más.
 * Misma regla que `public.dx_search_normalize` en Postgres.
 */
export function priceListNameKey(name: string): string {
  return normalizePriceListName(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

export function validatePriceListName(name: string): string | null {
  const length = normalizePriceListName(name).length;
  return length >= PRICE_LIST_NAME_MIN && length <= PRICE_LIST_NAME_MAX
    ? null
    : PRICE_LIST_NAME_MESSAGE;
}

/** Los `catalogItemId` que aparecen más de una vez en un mismo lote. */
export function duplicatedCatalogItemIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}
