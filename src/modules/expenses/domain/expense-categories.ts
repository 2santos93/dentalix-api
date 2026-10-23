/**
 * Categorías predefinidas de gastos (DX-274, R3). Son constantes de código,
 * no filas: las categorías propias de cada clínica viven en
 * `expense_categories`. El gasto guarda una FOTO del nombre.
 */
export const PREDEFINED_EXPENSE_CATEGORIES: readonly string[] = [
  'Insumos clínicos',
  'Laboratorio',
  'Mensajería',
  'Aseo y cafetería',
  'Papelería',
  'Servicios públicos',
  'Arriendo',
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
