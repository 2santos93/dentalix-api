import { LEGACY_PREDEFINED_CATEGORY_KEYS } from './legacy-expense-categories';

/**
 * Categorías predefinidas de gastos (DX-274, R3). Son constantes de código,
 * no filas: las categorías propias de cada clínica viven en
 * `expense_categories`. El gasto guarda una FOTO del nombre. Términos neutros,
 * sin regionalismos (DX-274-bis): «Alquiler» y «Limpieza y cafetería».
 */
export const PREDEFINED_EXPENSE_CATEGORIES: readonly string[] = [
  'Insumos clínicos',
  'Laboratorio',
  'Mensajería',
  'Limpieza y cafetería',
  'Papelería',
  'Servicios públicos',
  'Alquiler',
  'Mantenimiento',
  'Honorarios',
  'Impuestos y trámites',
  'Otros',
];

/** Espacios de los extremos fuera y los internos colapsados a uno. */
export function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Clave de comparación: minúsculas y sin tildes. Misma regla que
 * `public.dx_search_normalize` en Postgres.
 */
export function categoryKey(name: string): string {
  return normalizeCategoryName(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** La predefinida que coincide (sin mayúsculas ni tildes), con su grafía. */
export function matchPredefinedCategory(name: string): string | null {
  const key = categoryKey(name);
  return (
    PREDEFINED_EXPENSE_CATEGORIES.find((c) => categoryKey(c) === key) ?? null
  );
}

/**
 * Si `name` es el nombre ANTERIOR de una predefinida (DX-274-bis), la
 * predefinida actual con su grafía; si no, null. Es un alias de entrada:
 * crear, editar o filtrar con él da la categoría nueva, y crear una propia
 * con él es un duplicado (409), como con cualquier predefinida.
 */
export function matchLegacyPredefinedCategory(name: string): string | null {
  return LEGACY_PREDEFINED_CATEGORY_KEYS.get(categoryKey(name)) ?? null;
}

/**
 * La categoría de un FILTRO (lista, CSV, rentabilidad): la predefinida con su
 * grafía si coincide, también por su nombre anterior (DX-274-bis); si no, el
 * nombre tal cual llega, sin espacios de más (una propia o una ya retirada).
 */
export function categoryFilterName(raw: string): string {
  const name = normalizeCategoryName(raw);
  return (
    matchPredefinedCategory(name) ?? matchLegacyPredefinedCategory(name) ?? name
  );
}
