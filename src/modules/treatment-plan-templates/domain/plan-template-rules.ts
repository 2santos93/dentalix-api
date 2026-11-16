/**
 * Reglas de las plantillas de plan de tratamiento (DX-559). Puras: las
 * comparten los casos de uso (400 en español) y los tests; la migración
 * repite los topes como CHECK, que es la red si algo se saltara la API.
 *
 * Una plantilla agrupa procedimientos del catálogo por visitas, con los días
 * mínimos entre visitas (`visitIntervals`, misma forma que la del plan). No
 * guarda precios ni descuentos.
 */

export const PLAN_TEMPLATE_NAME_MAX = 80;
export const PLAN_TEMPLATE_LINES_MAX = 50;
export const PLAN_TEMPLATE_QUANTITY_MAX = 20;
export const PLAN_TEMPLATE_VISIT_MAX = 50;
export const PLAN_TEMPLATE_VISIT_LABEL_MAX = 60;
export const PLAN_TEMPLATE_INTERVAL_DAYS_MAX = 3650;

/** Días mínimos tras la visita N-1, por la clave N ("2".."50"). */
export type VisitIntervals = Record<string, number>;

export interface PlanTemplateLineDraft {
  catalogItemId: string;
  quantity: number;
  visit: number;
  visitLabel: string | null;
  asksSurfaces: boolean;
}

export interface PlanTemplateDraft {
  name: string;
  visitIntervals: VisitIntervals;
  lines: PlanTemplateLineDraft[];
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Recorta textos; una etiqueta vacía pasa a null; ids en minúsculas. */
export function normalizePlanTemplate(
  draft: PlanTemplateDraft,
): PlanTemplateDraft {
  return {
    name: draft.name.trim(),
    visitIntervals: { ...draft.visitIntervals },
    lines: draft.lines.map((line) => ({
      catalogItemId: line.catalogItemId.toLowerCase(),
      quantity: line.quantity,
      visit: line.visit,
      visitLabel: trimOrNull(line.visitLabel),
      asksSurfaces: line.asksSurfaces,
    })),
  };
}

function isIntIn(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function lineError(line: PlanTemplateLineDraft, n: number): string | null {
  if (!isIntIn(line.quantity, 1, PLAN_TEMPLATE_QUANTITY_MAX)) {
    return `La cantidad de la línea ${n} debe ser un entero entre 1 y ${PLAN_TEMPLATE_QUANTITY_MAX}`;
  }
  if (!isIntIn(line.visit, 1, PLAN_TEMPLATE_VISIT_MAX)) {
    return `La visita de la línea ${n} debe ser un entero entre 1 y ${PLAN_TEMPLATE_VISIT_MAX}`;
  }
  if (
    line.visitLabel !== null &&
    line.visitLabel.length > PLAN_TEMPLATE_VISIT_LABEL_MAX
  ) {
    return `La etiqueta de visita de la línea ${n} no puede tener más de ${PLAN_TEMPLATE_VISIT_LABEL_MAX} caracteres`;
  }
  return null;
}

/**
 * Primer problema de una plantilla, o null si es válida. El orden importa:
 * primero lo que el usuario ve arriba del formulario.
 */
export function planTemplateError(raw: PlanTemplateDraft): string | null {
  const draft = normalizePlanTemplate(raw);
  if (draft.name === '') {
    return 'El nombre de la plantilla no puede estar vacío';
  }
  if (draft.name.length > PLAN_TEMPLATE_NAME_MAX) {
    return `El nombre de la plantilla no puede tener más de ${PLAN_TEMPLATE_NAME_MAX} caracteres`;
  }
  if (draft.lines.length === 0) {
    return 'La plantilla necesita al menos un procedimiento';
  }
  if (draft.lines.length > PLAN_TEMPLATE_LINES_MAX) {
    return `Una plantilla admite como máximo ${PLAN_TEMPLATE_LINES_MAX} procedimientos`;
  }
  const labels = new Map<number, string | null>();
  for (const [i, line] of draft.lines.entries()) {
    const error = lineError(line, i + 1);
    if (error) return error;
    // Como en el plan (DX-256): los ítems de una visita comparten etiqueta.
    if (labels.has(line.visit) && labels.get(line.visit) !== line.visitLabel) {
      return `Los procedimientos de la visita ${line.visit} deben tener la misma etiqueta`;
    }
    labels.set(line.visit, line.visitLabel);
  }
  const lastVisit = Math.max(...draft.lines.map((l) => l.visit));
  for (const [key, days] of Object.entries(draft.visitIntervals)) {
    if (!/^[1-9]\d?$/.test(key) || !isIntIn(Number(key), 2, lastVisit)) {
      return lastVisit < 2
        ? 'Una plantilla de una sola visita no lleva días entre visitas'
        : `Los días entre visitas solo van de la visita 2 a la ${lastVisit} de la plantilla`;
    }
    if (!isIntIn(days, 0, PLAN_TEMPLATE_INTERVAL_DAYS_MAX)) {
      return `Los días antes de la visita ${key} deben ser un entero entre 0 y ${PLAN_TEMPLATE_INTERVAL_DAYS_MAX}`;
    }
  }
  return null;
}

/** Clave con la que se comparan los nombres (sin mayúsculas ni espacios de más). */
export function planTemplateNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}
