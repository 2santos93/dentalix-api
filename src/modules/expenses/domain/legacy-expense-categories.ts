/**
 * DX-274-bis: los nombres ANTERIORES de dos categorías predefinidas, que eran
 * regionalismos y se cambiaron por términos neutros. Solo se guardan como
 * alias de entrada: una URL guardada, un cliente antiguo o un CSV que aún
 * mande el nombre viejo cae en la categoría nueva en vez de dar un 400 o una
 * lista vacía. Ningún nombre viejo se muestra ni se guarda: la migración
 * 20261219090000_dx274b_expense_category_neutral_names reescribió las fotos de
 * los gastos.
 *
 * Claves en la forma de `categoryKey` (minúsculas, sin tildes ni espacios de
 * más). Es el único fichero de `src` que puede nombrarlos: lo exceptúa la
 * guarda `src/architecture/no-regional-expense-categories.spec.ts`.
 */
export const LEGACY_PREDEFINED_CATEGORY_KEYS: ReadonlyMap<string, string> =
  new Map([
    ['arriendo', 'Alquiler'],
    ['aseo y cafeteria', 'Limpieza y cafetería'],
  ]);
