import type { RecallContactOutcome } from '@prisma/client';
import { addCivilDays, parseCivilDate } from '../../../shared/time/civil-day';
import { addCivilMonths } from './recall-rules';

/**
 * DX-465 · El ciclo de intentos de un recall. `recall_contacts` es el intento
 * (DX-015); aquí está el ESTADO que deja cada uno en `patient_recalls`, que la
 * app escribe en la misma transacción que el contacto, con la fila bloqueada.
 *
 * El estado vale para el vencimiento `cycleDueAt`: si `dueAt` ya es otro (se
 * hizo el control y un disparador movió la base, o el clínico fijó otra
 * fecha), el ciclo empezó de nuevo y todo cuenta como 0/NULL, sin tener que
 * reescribir la fila desde los triggers del recall.
 *
 * Desenlaces:
 *  - NO_ANSWER, LEFT_MESSAGE, WILL_BOOK, WRONG_NUMBER: +1 intento; oculto hasta
 *    el día civil del intento en la sede + los días de la sede.
 *  - CALL_BACK: +1; oculto hasta `callbackOn` (si llega; sin fecha, como los
 *    anteriores).
 *  - DECLINED: contador a 0; no sale hasta el vencimiento siguiente (`dueAt` +
 *    el intervalo del recall). No toca la pausa clínica (`disabledUntil`).
 *  - BOOKED: cierra el ciclo (contador a 0, sin ocultar ni «Llamar luego»).
 * Cualquier intento que no sea DECLINED quita el `skipUntil` de un DECLINED
 * anterior: alguien volvió a llamar a propósito («Incluir contactados»).
 *
 * «Intentos agotados»: `attempts ≥ maxAttempts` de la sede.
 */

/** Ajustes por sede (DX-465, D2): sin fila, estos. */
export const RECALL_HIDE_DAYS_DEFAULT = 7;
export const RECALL_HIDE_DAYS_MIN = 1;
export const RECALL_HIDE_DAYS_MAX = 90;
export const RECALL_MAX_ATTEMPTS_DEFAULT = 3;
export const RECALL_MAX_ATTEMPTS_MIN = 1;
export const RECALL_MAX_ATTEMPTS_MAX = 10;
/** «Llamar luego»: como mucho dentro de 90 días de la sede. */
export const RECALL_CALLBACK_MAX_DAYS = 90;
/** Registrar varios a la vez (D5). */
export const RECALL_BATCH_MAX = 50;

export interface RecallSettingsValues {
  hideDays: number;
  maxAttempts: number;
}

export const RECALL_SETTINGS_DEFAULTS: RecallSettingsValues = {
  hideDays: RECALL_HIDE_DAYS_DEFAULT,
  maxAttempts: RECALL_MAX_ATTEMPTS_DEFAULT,
};

/** Lo que guarda `patient_recalls` del ciclo. */
export interface RecallCycleState {
  attemptCount: number;
  /** Hora del servidor del último intento (el `createdAt` del contacto). */
  lastAttemptAt: Date | null;
  callbackOn: string | null;
  skipUntil: string | null;
  /** El vencimiento al que se refiere. */
  cycleDueAt: string | null;
}

export const EMPTY_CYCLE: Omit<RecallCycleState, 'cycleDueAt'> = {
  attemptCount: 0,
  lastAttemptAt: null,
  callbackOn: null,
  skipUntil: null,
};

/** Los desenlaces que cuentan como intento (todos salvo los que cierran). */
export const COUNTED_OUTCOMES: readonly RecallContactOutcome[] = [
  'NO_ANSWER',
  'LEFT_MESSAGE',
  'CALL_BACK',
  'WILL_BOOK',
  'WRONG_NUMBER',
];

/** El estado guardado, o uno vacío si es de otro vencimiento. */
export function currentCycle(
  stored: RecallCycleState,
  dueAt: string,
): RecallCycleState {
  return stored.cycleDueAt === dueAt
    ? stored
    : { ...EMPTY_CYCLE, cycleDueAt: dueAt };
}

export interface RecallOutcomeInput {
  outcome: RecallContactOutcome;
  /** Hora del servidor del contacto. */
  at: Date;
  /** Vencimiento guardado del recall ahora. */
  dueAt: string;
  intervalMonths: number;
  /** Solo con CALL_BACK (ya validada). */
  callbackOn: string | null;
}

/** El estado que deja un contacto (D1). */
export function nextCycleState(
  stored: RecallCycleState,
  input: RecallOutcomeInput,
): RecallCycleState {
  const cycle = currentCycle(stored, input.dueAt);
  switch (input.outcome) {
    case 'BOOKED':
      return { ...EMPTY_CYCLE, cycleDueAt: input.dueAt };
    case 'DECLINED':
      return {
        attemptCount: 0,
        lastAttemptAt: input.at,
        callbackOn: null,
        skipUntil: addCivilMonths(input.dueAt, input.intervalMonths),
        cycleDueAt: input.dueAt,
      };
    case 'CALL_BACK':
      return {
        attemptCount: cycle.attemptCount + 1,
        lastAttemptAt: input.at,
        callbackOn: input.callbackOn,
        skipUntil: null,
        cycleDueAt: input.dueAt,
      };
    default:
      return {
        attemptCount: cycle.attemptCount + 1,
        lastAttemptAt: input.at,
        callbackOn: null,
        skipUntil: null,
        cycleDueAt: input.dueAt,
      };
  }
}

/** Lo que ve la lista y la ficha de un recall en un día de su sede. */
export interface RecallCycleView {
  attempts: number;
  maxAttempts: number;
  exhausted: boolean;
  /** Día civil (sede) del último intento del ciclo. */
  lastAttemptDay: string | null;
  /** «Llamar luego» del ciclo. */
  callbackOn: string | null;
  /** Hasta qué día no sale por defecto (exclusivo); null si ya sale. */
  hiddenUntil: string | null;
}

/**
 * `lastAttemptDay` es el día civil de `lastAttemptAt` en la zona de la sede
 * del paciente (lo calcula quien lee: la SQL o `civilDateIn`).
 */
export function cycleView(
  stored: RecallCycleState,
  facts: {
    dueAt: string;
    today: string;
    lastAttemptDay: string | null;
    settings: RecallSettingsValues;
  },
): RecallCycleView {
  const cycle = currentCycle(stored, facts.dueAt);
  const inCycle = stored.cycleDueAt === facts.dueAt;
  const lastAttemptDay = inCycle ? facts.lastAttemptDay : null;
  const until = maxDay([
    cycle.callbackOn ??
      (lastAttemptDay
        ? addCivilDays(lastAttemptDay, facts.settings.hideDays)
        : null),
    cycle.skipUntil,
  ]);
  return {
    attempts: cycle.attemptCount,
    maxAttempts: facts.settings.maxAttempts,
    exhausted: cycle.attemptCount >= facts.settings.maxAttempts,
    lastAttemptDay,
    callbackOn: cycle.callbackOn,
    hiddenUntil: until !== null && until > facts.today ? until : null,
  };
}

function maxDay(days: (string | null)[]): string | null {
  return days.reduce<string | null>(
    (acc, d) => (d !== null && (acc === null || d > acc) ? d : acc),
    null,
  );
}

export const CALLBACK_ON_INVALID_MESSAGE =
  'La fecha para volver a llamar debe ser una fecha válida (AAAA-MM-DD).';
export const CALLBACK_ON_PAST_MESSAGE =
  'La fecha para volver a llamar no puede ser anterior a hoy.';
export const CALLBACK_ON_TOO_FAR_MESSAGE = `La fecha para volver a llamar admite hasta ${RECALL_CALLBACK_MAX_DAYS} días desde hoy.`;
export const CALLBACK_ON_ONLY_CALL_BACK_MESSAGE =
  'La fecha para volver a llamar solo va con «Llamar luego».';
export const CALLBACK_ON_REQUIRED_MESSAGE =
  '«Llamar luego» necesita la fecha para volver a llamar.';

/** La fecha de «Llamar luego» contra el «hoy» de la sede; null si vale. */
export function callbackOnError(value: string, today: string): string | null {
  const day = parseCivilDate(value);
  if (day === null) return CALLBACK_ON_INVALID_MESSAGE;
  if (day < today) return CALLBACK_ON_PAST_MESSAGE;
  if (day > addCivilDays(today, RECALL_CALLBACK_MAX_DAYS)) {
    return CALLBACK_ON_TOO_FAR_MESSAGE;
  }
  return null;
}

export const RECALL_SETTINGS_HIDE_DAYS_MESSAGE = `Los días de ocultación van de ${RECALL_HIDE_DAYS_MIN} a ${RECALL_HIDE_DAYS_MAX}.`;
export const RECALL_SETTINGS_MAX_ATTEMPTS_MESSAGE = `El tope de intentos va de ${RECALL_MAX_ATTEMPTS_MIN} a ${RECALL_MAX_ATTEMPTS_MAX}.`;

/** Los ajustes de una sede (D2); null si valen. */
export function recallSettingsError(
  input: RecallSettingsValues,
): string | null {
  if (
    !Number.isInteger(input.hideDays) ||
    input.hideDays < RECALL_HIDE_DAYS_MIN ||
    input.hideDays > RECALL_HIDE_DAYS_MAX
  ) {
    return RECALL_SETTINGS_HIDE_DAYS_MESSAGE;
  }
  if (
    !Number.isInteger(input.maxAttempts) ||
    input.maxAttempts < RECALL_MAX_ATTEMPTS_MIN ||
    input.maxAttempts > RECALL_MAX_ATTEMPTS_MAX
  ) {
    return RECALL_SETTINGS_MAX_ATTEMPTS_MESSAGE;
  }
  return null;
}

/** Motivo de la auditoría de los ajustes (UPDATE CLINIC_SETTINGS). */
export const RECALL_SETTINGS_REASON = 'RECALL_SETTINGS_UPDATED';
