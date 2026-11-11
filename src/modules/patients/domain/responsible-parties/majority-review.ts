import { civilDateIn } from '../../../../shared/time/civil-day';
import { isMinor } from './majority-age';

/**
 * DX-342: paso a la mayoría de edad.
 *
 * Un paciente que tenía responsable de menor y ya cumplió la mayoría de edad
 * de la clínica no sigue mandando sus avisos, recibos y estados de cuenta al
 * responsable sin que alguien lo revise: hasta que la recepción confirme qué
 * quiere el paciente, sus envíos van a él (o a nadie, si no tiene email).
 */

/**
 * - PATIENT_SELF: los envíos van al propio paciente (sin email: a nadie).
 * - KEEP_RESPONSIBLE: el paciente consiente; vuelve la regla de DX-203.
 */
export type MajorityReviewDecision = 'PATIENT_SELF' | 'KEEP_RESPONSIBLE';
export const MAJORITY_REVIEW_DECISIONS: readonly MajorityReviewDecision[] = [
  'PATIENT_SELF',
  'KEEP_RESPONSIBLE',
];

/**
 * - NOT_APPLICABLE: menor, sin fecha de nacimiento o sin un responsable vivo
 *   dado de alta ANTES de su mayoría de edad (un adulto mayor con
 *   responsable dado de alta ya adulto sigue con DX-203 tal cual).
 * - PENDING: cumplió la mayoría de edad con responsable y nadie lo revisó
 *   para esa fecha.
 * - REVIEWED: hay una revisión para su fecha de mayoría de edad vigente.
 */
export type MajorityReviewStatus = 'NOT_APPLICABLE' | 'PENDING' | 'REVIEWED';

/** La última revisión guardada del paciente. */
export interface MajorityReviewRecord {
  decision: MajorityReviewDecision;
  /** Fecha de mayoría de edad (YYYY-MM-DD) para la que se revisó. */
  majorityDate: string;
}

export const MAJORITY_REVIEW_NOTE_MAX = 500;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Día civil (YYYY-MM-DD) en que el paciente cumple `majorityAge` años: el
 * primero en que `isMinor` es falso. Quien nació un 29 de febrero la cumple
 * el 1 de marzo de un año no bisiesto (como `ageInYears`). Sin fecha de
 * nacimiento, null.
 */
export function majorityDateOf(
  birthDate: Date | null,
  majorityAge: number,
): string | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate
    .toISOString()
    .slice(0, 10)
    .split('-')
    .map(Number);
  const year = by + majorityAge;
  if (bm === 2 && bd === 29 && !isLeap(year)) return `${pad(year, 4)}-03-01`;
  return `${pad(year, 4)}-${pad(bm)}-${pad(bd)}`;
}

export interface MajorityReviewInput {
  birthDate: Date | null;
  majorityAge: number;
  /** Día civil (YYYY-MM-DD) de la sede. */
  today: string;
  /** Zona de la sede: da el día civil del alta de cada responsable. */
  timeZone: string;
  /** Responsables VIVOS del paciente, con su alta. */
  responsibles: readonly { createdAt: Date }[];
  /** Última revisión guardada (de cualquier fecha). */
  review: MajorityReviewRecord | null;
}

export interface MajorityReviewState {
  status: MajorityReviewStatus;
  /** Fecha de mayoría de edad vigente; null sin fecha de nacimiento. */
  majorityDate: string | null;
  /** La decisión que rige (solo con REVIEWED). */
  decision: MajorityReviewDecision | null;
}

/**
 * ¿Cumplió la mayoría de edad con responsable y está revisado? La revisión
 * solo vale para la fecha de mayoría de edad para la que se hizo: si cambia
 * la fecha de nacimiento o la mayoría de edad de la clínica, vuelve a
 * PENDING.
 */
export function majorityReviewState(
  input: MajorityReviewInput,
): MajorityReviewState {
  const majorityDate = majorityDateOf(input.birthDate, input.majorityAge);
  const notApplicable: MajorityReviewState = {
    status: 'NOT_APPLICABLE',
    majorityDate,
    decision: null,
  };
  if (!majorityDate) return notApplicable;
  if (isMinor(input.birthDate, input.majorityAge, input.today)) {
    return notApplicable;
  }
  const addedWhileMinor = input.responsibles.some(
    (r) => civilDateIn(r.createdAt, input.timeZone) < majorityDate,
  );
  if (!addedWhileMinor) return notApplicable;
  if (input.review && input.review.majorityDate === majorityDate) {
    return {
      status: 'REVIEWED',
      majorityDate,
      decision: input.review.decision,
    };
  }
  return { status: 'PENDING', majorityDate, decision: null };
}

/**
 * ¿Sus envíos tienen que ir al propio paciente (nunca al responsable)? Sí si
 * cumplió la mayoría de edad con responsable y no hay una revisión vigente
 * que confirme KEEP_RESPONSIBLE.
 */
export function noticesStayWithPatient(state: MajorityReviewState): boolean {
  if (state.status === 'PENDING') return true;
  return state.status === 'REVIEWED' && state.decision === 'PATIENT_SELF';
}
