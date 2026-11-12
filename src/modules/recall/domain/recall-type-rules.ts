import { RECALL_INTERVAL_MAX, RECALL_INTERVAL_MIN } from './recall-rules';

/**
 * DX-015-bis · Reglas de un tipo de recall (Ajustes › Recall, D11–D13).
 * Puras: las comparten el caso de uso (400 en español) y los tests; la BD
 * repite cada una como CHECK (`recall_types_*_check`), que es la red si algo
 * se saltara la API.
 */

export const RECALL_TYPE_NAME_MAX = 60;
/** D13: el grupo de exclusión, tal como lo recibe la API. */
export const RECALL_EXCLUSION_GROUP = /^[A-Z0-9_]{1,40}$/;
export const RECALL_TYPE_SORT_MIN = 0;
export const RECALL_TYPE_SORT_MAX = 9999;
/** Disparadores por tipo (también el tope de una lista en la auditoría). */
export const RECALL_TYPE_TRIGGERS_MAX = 50;
/** Hueco entre tipos al dar de alta uno sin orden: va el último. */
export const RECALL_TYPE_SORT_STEP = 10;

export const RECALL_TYPE_NAME_EMPTY_MESSAGE = 'El nombre no puede estar vacío.';
export const RECALL_TYPE_NAME_TOO_LONG_MESSAGE = `El nombre no puede tener más de ${RECALL_TYPE_NAME_MAX} caracteres.`;
export const RECALL_TYPE_INTERVAL_MESSAGE = `El intervalo por defecto va de ${RECALL_INTERVAL_MIN} a ${RECALL_INTERVAL_MAX} meses.`;
export const RECALL_EXCLUSION_GROUP_MESSAGE =
  'El grupo de exclusión admite de 1 a 40 letras mayúsculas, cifras o «_» (por ejemplo, HYGIENE_PERIO).';
export const RECALL_TYPE_SORT_MESSAGE = `El orden va de ${RECALL_TYPE_SORT_MIN} a ${RECALL_TYPE_SORT_MAX}.`;
export const RECALL_TYPE_TRIGGERS_MAX_MESSAGE = `Un tipo admite hasta ${RECALL_TYPE_TRIGGERS_MAX} procedimientos.`;

export function recallTypeNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return RECALL_TYPE_NAME_EMPTY_MESSAGE;
  if (trimmed.length > RECALL_TYPE_NAME_MAX) {
    return RECALL_TYPE_NAME_TOO_LONG_MESSAGE;
  }
  return null;
}

export function recallTypeIntervalError(months: number): string | null {
  return Number.isInteger(months) &&
    months >= RECALL_INTERVAL_MIN &&
    months <= RECALL_INTERVAL_MAX
    ? null
    : RECALL_TYPE_INTERVAL_MESSAGE;
}

/** `null` = sin exclusión (quitarla deja el grupo del tipo vacío, D13). */
export function exclusionGroupError(group: string | null): string | null {
  return group === null || RECALL_EXCLUSION_GROUP.test(group)
    ? null
    : RECALL_EXCLUSION_GROUP_MESSAGE;
}

export function recallTypeSortOrderError(sortOrder: number): string | null {
  return Number.isInteger(sortOrder) &&
    sortOrder >= RECALL_TYPE_SORT_MIN &&
    sortOrder <= RECALL_TYPE_SORT_MAX
    ? null
    : RECALL_TYPE_SORT_MESSAGE;
}

/** Los ids sin repetir y en orden estable (el conjunto es lo que cuenta). */
export function normalizeTriggerIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

export function triggerIdsError(ids: readonly string[]): string | null {
  return normalizeTriggerIds(ids).length > RECALL_TYPE_TRIGGERS_MAX
    ? RECALL_TYPE_TRIGGERS_MAX_MESSAGE
    : null;
}
