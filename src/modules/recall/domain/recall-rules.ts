import {
  addCivilDays,
  civilDaysInclusive,
  parseCivilDate,
} from '../../../shared/time/civil-day';

/**
 * DX-015 · Reglas del recall. DX-015-bis: el vencimiento ya no se calcula al
 * leer: es la columna generada `patient_recalls.dueAt` ("lastDoneAt" +
 * intervalo, `make_interval`), la misma para la lista, la ficha y la salida
 * del paciente. Aquí queda el estado en un día y `addCivilMonths`, la misma
 * cuenta en TypeScript (la usan el seed-demo y los tests, que comprueban que
 * coincide con la de la BD en fin de mes y 29/02).
 */

/** Tope del intervalo (CHECK en la BD). */
export const RECALL_INTERVAL_MIN = 1;
export const RECALL_INTERVAL_MAX = 36;
/** Ventana máxima de «vence pronto» de la lista. */
export const RECALL_WITHIN_DAYS_MAX = 60;

/**
 * `day` + `months` meses de calendario, con el día recortado al último del mes
 * de llegada (31/01 + 1 → 28/02 o 29/02; 29/02 + 12 → 28/02). Es lo que hace
 * Postgres con `date + make_interval(months => n)`.
 */
export function addCivilMonths(day: string, months: number): string {
  if (parseCivilDate(day) === null) {
    throw new RangeError(`Invalid civil date: ${day}`);
  }
  const [y, m, d] = day.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12; // 0..11
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dd = Math.min(d, lastDay);
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Lo que decide el estado de un recall en un día. */
export interface RecallFacts {
  /**
   * Base: lo fijado por el clínico o el día civil del último DONE de un
   * procedimiento disparador, el más reciente (`dx_recall_recompute`).
   */
  lastDoneAt: string;
  /** Vencimiento guardado (`patient_recalls.dueAt`). */
  dueAt: string;
  active: boolean;
  disabledUntil: string | null;
  /** Cita futura agendada/confirmada o en curso, en cualquier sede. */
  hasUpcomingAppointment: boolean;
  /** Paciente archivado. */
  archived: boolean;
}

export type RecallStatus =
  /** Vencido y sin cita: va a la lista de llamada. */
  | 'DUE'
  /** Vence en el futuro. */
  | 'UPCOMING'
  /** Vencido o por vencer, pero ya tiene cita: no se llama. */
  | 'SCHEDULED'
  /** Desactivado hasta una fecha que aún no llega. */
  | 'PAUSED'
  /** Recall retirado o paciente archivado. */
  | 'INACTIVE';

export interface RecallState {
  /** Base del vencimiento: la más reciente entre lo fijado y el último DONE. */
  baseDate: string;
  dueAt: string;
  /** Días desde el vencimiento (0 = vence hoy; negativo = faltan). */
  daysOverdue: number;
  status: RecallStatus;
}

/** Días de `from` a `to` (`to - from`). */
export function civilDayDiff(from: string, to: string): number {
  return from <= to
    ? civilDaysInclusive(from, to) - 1
    : -(civilDaysInclusive(to, from) - 1);
}

/**
 * Estado del recall en `today` (día civil de la sede).
 *
 * - DX-015-bis: el reloj lo mueven lo fijado a mano y el DONE de un
 *   procedimiento disparador del tipo, NO cualquier cita atendida (una
 *   obturación no retrasa la limpieza).
 * - Con cita futura (o en curso) no se llama: `SCHEDULED`. Al cancelarla,
 *   vuelve a `DUE` sin tocar nada.
 * - Desactivado hasta un día: `PAUSED` hasta ese día (inclusive el anterior).
 */
export function recallState(facts: RecallFacts, today: string): RecallState {
  const baseDate = facts.lastDoneAt;
  const { dueAt } = facts;
  const daysOverdue = civilDayDiff(dueAt, today);
  let status: RecallStatus;
  if (!facts.active || facts.archived) status = 'INACTIVE';
  else if (facts.disabledUntil && facts.disabledUntil > today)
    status = 'PAUSED';
  else if (facts.hasUpcomingAppointment) status = 'SCHEDULED';
  else if (dueAt <= today) status = 'DUE';
  else status = 'UPCOMING';
  return { baseDate, dueAt, daysOverdue, status };
}

/**
 * ¿Sale en la lista de llamada? Vencido (o que vence en ≤ `withinDays`), sin
 * cita, activo y sin pausa vigente.
 */
export function isOnCallList(
  facts: RecallFacts,
  today: string,
  withinDays = 0,
): boolean {
  const state = recallState(facts, addCivilDays(today, withinDays));
  // La pausa se mide con el día real, no con la ventana.
  if (facts.disabledUntil && facts.disabledUntil > today) return false;
  return state.status === 'DUE';
}
