import { addCivilDays } from '../../../shared/time/civil-day';
import { ageInDays } from './aging';

/*
 * «Por avisar hoy» (DX-146): a qué deudores toca avisarles hoy de su saldo
 * vencido, por tramos de antigüedad.
 *
 * - La DEUDA de un paciente es la que hace exigible su línea vencida más
 *   antigua: empieza el día en que venció (hoy − `oldestAgeDays`, en días
 *   civiles de la zona de la sede de la deuda, DX-110). Si la salda y vuelve a
 *   deber, o un abono cubre esa línea y la siguiente es más nueva, la deuda
 *   empieza otro día: los avisos anteriores ya no cuentan para ella.
 * - TRAMO: el mayor umbral de la política (7, 30 y 60 días por defecto) que la
 *   antigüedad ya alcanzó. Cada tramo pide UN aviso: si el último aviso de esta
 *   deuda se dio con la antigüedad ya en el tramo actual, ese tramo está
 *   avisado (quien llega tarde a un tramo no recibe los anteriores).
 * - Topes: como mucho `maxNotices` avisos por deuda y al menos `minGapDays`
 *   días entre dos avisos (aunque la clínica cambie los tramos). Un aviso de
 *   hoy siempre lo saca de la lista hasta mañana.
 *
 * Los avisos son las notas de cobranza REMINDER_SENT (append-only), con su día
 * civil en la misma zona que la deuda.
 */

export interface BalanceReminderPolicy {
  /** Umbrales en días, estrictamente crecientes (1 a 3 valores, 1..365). */
  days: number[];
  maxNotices: number;
  minGapDays: number;
}

export const DEFAULT_BALANCE_REMINDER_POLICY: Readonly<BalanceReminderPolicy> =
  Object.freeze({ days: [7, 30, 60], maxNotices: 3, minGapDays: 7 });

export const REMINDER_DAYS_MIN = 1;
export const REMINDER_DAYS_MAX = 365;
export const REMINDER_STAGES_MAX = 3;
export const REMINDER_MAX_NOTICES_MAX = 10;
export const REMINDER_MIN_GAP_DAYS_MAX = 90;

export interface ReminderInput {
  /** Hoy (YYYY-MM-DD) en la zona de la sede de la deuda. */
  today: string;
  /** Días de la línea exigible más antigua; `null` o < 1: nada vencido. */
  oldestAgeDays: number | null;
  /** Días civiles (misma zona) de los avisos REMINDER_SENT del paciente. */
  noticeDays: readonly string[];
}

export interface ReminderDecision {
  due: boolean;
  /** Tramo alcanzado (1 = primer umbral); 0 si aún no llega a ninguno. */
  stage: number;
  /** Umbral del tramo alcanzado (días); `null` si `stage` es 0. */
  stageDays: number | null;
  /** Avisos que ya se dieron para ESTA deuda. */
  noticesSent: number;
  /** Último aviso de esta deuda (día civil); `null` si ninguno. */
  lastNoticeOn: string | null;
  /** Día en que empezó la deuda (venció su línea más antigua). */
  debtSince: string | null;
}

/** Tramo alcanzado por `ageDays` (0 = ninguno). `days` va creciente. */
export function reminderStage(
  days: readonly number[],
  ageDays: number,
): number {
  let stage = 0;
  for (const threshold of days) {
    if (ageDays >= threshold) stage += 1;
  }
  return stage;
}

export function decideReminder(
  policy: BalanceReminderPolicy,
  input: ReminderInput,
): ReminderDecision {
  const age = input.oldestAgeDays;
  if (age === null || age < 1) {
    return {
      due: false,
      stage: 0,
      stageDays: null,
      noticesSent: 0,
      lastNoticeOn: null,
      debtSince: null,
    };
  }
  const debtSince = addCivilDays(input.today, -age);
  // Solo los avisos de ESTA deuda (desde que venció su línea más antigua, sin
  // los «del futuro» que daría un reloj desajustado).
  const notices = input.noticeDays
    .filter((day) => day >= debtSince && day <= input.today)
    .sort();
  const lastNoticeOn = notices.length > 0 ? notices[notices.length - 1] : null;
  const stage = reminderStage(policy.days, age);
  const stageDays = stage > 0 ? policy.days[stage - 1] : null;
  const base = {
    stage,
    stageDays,
    noticesSent: notices.length,
    lastNoticeOn,
    debtSince,
  };
  if (stageDays === null) return { due: false, ...base };
  if (notices.length >= policy.maxNotices) return { due: false, ...base };
  if (lastNoticeOn !== null) {
    // El tramo actual ya se avisó: el último aviso fue con la deuda en él.
    if (ageInDays(debtSince, lastNoticeOn) >= stageDays) {
      return { due: false, ...base };
    }
    if (ageInDays(lastNoticeOn, input.today) < policy.minGapDays) {
      return { due: false, ...base };
    }
  }
  return { due: true, ...base };
}

/**
 * La política es válida: 1 a 3 umbrales enteros, estrictamente crecientes,
 * entre 1 y 365; tope de avisos 1..10 y separación 1..90. Devuelve el mensaje
 * del primer fallo (en español) o `null`.
 */
export function policyError(policy: BalanceReminderPolicy): string | null {
  const { days, maxNotices, minGapDays } = policy;
  if (days.length < 1 || days.length > REMINDER_STAGES_MAX) {
    return `Indica de 1 a ${REMINDER_STAGES_MAX} tramos de días.`;
  }
  if (
    days.some(
      (d) =>
        !Number.isInteger(d) || d < REMINDER_DAYS_MIN || d > REMINDER_DAYS_MAX,
    )
  ) {
    return `Cada tramo es un número entero de días entre ${REMINDER_DAYS_MIN} y ${REMINDER_DAYS_MAX}.`;
  }
  for (let i = 1; i < days.length; i += 1) {
    if (days[i] <= days[i - 1]) {
      return 'Los tramos van de menor a mayor, sin repetir días.';
    }
  }
  if (
    !Number.isInteger(maxNotices) ||
    maxNotices < 1 ||
    maxNotices > REMINDER_MAX_NOTICES_MAX
  ) {
    return `El máximo de avisos por deuda va de 1 a ${REMINDER_MAX_NOTICES_MAX}.`;
  }
  if (
    !Number.isInteger(minGapDays) ||
    minGapDays < 1 ||
    minGapDays > REMINDER_MIN_GAP_DAYS_MAX
  ) {
    return `Los días mínimos entre avisos van de 1 a ${REMINDER_MIN_GAP_DAYS_MAX}.`;
  }
  return null;
}
