import type { VisitIntervals } from './plan-template-rules';

/** Tope de visita e intervalo de un plan (DX-256: CHECK visit 1..1000). */
export const PLAN_VISIT_MAX = 1000;

/**
 * DX-559 (D4): las visitas de la plantilla van DETRÁS de la última visita
 * viva del plan. El desplazamiento es la mayor `visit` de sus ítems vivos, o
 * 0 si no tiene ninguno (en un plan vacío, 1, 2 y 3 quedan como 1, 2 y 3).
 */
export function planVisitOffset(items: readonly { visit: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.visit), 0);
}

/** La visita del plan a la que va una visita de la plantilla. */
export function placedVisit(templateVisit: number, offset: number): number {
  return templateVisit + offset;
}

/** Los intervalos de la plantilla con sus claves desplazadas. */
export function shiftIntervals(
  intervals: VisitIntervals,
  offset: number,
): VisitIntervals {
  return Object.fromEntries(
    Object.entries(intervals).map(([key, days]) => [
      String(Number(key) + offset),
      days,
    ]),
  );
}

/**
 * Los intervalos del plan con los de la plantilla ya desplazados. Una clave
 * que el plan ya tiene NO se sobreescribe: lo que la clínica ya fijó manda.
 */
export function mergeIntervals(
  planIntervals: VisitIntervals,
  shifted: VisitIntervals,
): VisitIntervals {
  const merged: VisitIntervals = { ...planIntervals };
  for (const [key, days] of Object.entries(shifted)) {
    if (!(key in merged)) merged[key] = days;
  }
  return merged;
}

/**
 * ¿Alguna visita o clave de intervalo pasaría de 1000 al desplazarla? Se
 * mira con las visitas de las líneas que se aplican y todas las claves de la
 * plantilla.
 */
export function placementOverflows(
  templateVisits: readonly number[],
  intervals: VisitIntervals,
  offset: number,
): boolean {
  const highest = Math.max(
    0,
    ...templateVisits,
    ...Object.keys(intervals).map(Number),
  );
  return highest + offset > PLAN_VISIT_MAX;
}
