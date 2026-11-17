import { ClinicRole } from '@prisma/client';
import { effectiveBusinessCalendar } from '../../lab-orders/domain/lab-order-rules';
import {
  addBusinessDays,
  type BusinessCalendar,
} from '../../../shared/time/business-days';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';

/**
 * DX-566 · Control postoperatorio: reglas puras (sin BD ni reloj).
 */

export const POST_OP_ATTEMPT_OUTCOMES = [
  'FINE',
  'DISCOMFORT',
  'NEEDS_APPOINTMENT',
  'NO_ANSWER',
] as const;
export type PostOpAttemptOutcomeCode =
  (typeof POST_OP_ATTEMPT_OUTCOMES)[number];
export type PostOpCheckOutcomeCode = Exclude<
  PostOpAttemptOutcomeCode,
  'NO_ANSWER'
>;
export type PostOpCheckStatusCode =
  'PENDING' | 'DONE' | 'UNREACHABLE' | 'CANCELLED';

/** Al tercer «No contesta» el control se cierra como «No localizado». */
export const POST_OP_MAX_NO_ANSWER = 3;
export const POST_OP_NOTE_MAX = 1000;
/** Motivo fijo de la adenda o de la evolución nueva. */
export const POST_OP_HISTORY_REASON = 'Control postoperatorio';

export const POST_OP_MESSAGES = {
  forbidden:
    'Solo el personal clínico (odontólogo, asistente o administrador) registra el resultado de un control postoperatorio',
  notFound: 'Control postoperatorio no encontrado en esta clínica',
  closed: 'Este control postoperatorio ya está cerrado: no admite más intentos',
  noteTooLong: `La nota admite hasta ${POST_OP_NOTE_MAX} caracteres`,
  invalidOutcome:
    'El resultado debe ser Bien (FINE), Molestias (DISCOMFORT), Necesita cita (NEEDS_APPOINTMENT) o No contesta (NO_ANSWER)',
} as const;

/**
 * Día de la llamada: el n-ésimo día hábil de la sede DESPUÉS del día civil en
 * que se hizo el procedimiento (en la zona de la sede). Cuenta solo los días
 * que son laborables en el calendario de la sede (DX-316: días de la semana y
 * festivos) y que además tienen tramos en su horario (como el laboratorio,
 * `effectiveBusinessCalendar`). Avanza por días civiles: un cambio de hora no
 * mueve la fecha. `openWeekdays` null = la sede no tiene horario: no acota.
 */
export function postOpCheckDueOn(
  completedAt: Date,
  afterDays: number,
  calendar: BusinessCalendar,
  openWeekdays: readonly number[] | null,
  timeZone: string,
): string {
  return addBusinessDays(
    completedAt,
    afterDays,
    effectiveBusinessCalendar(calendar, openWeekdays),
    timeZone,
  );
}

/** Lo que deja un intento en el control. */
export type AttemptDecision =
  | { close: false }
  | {
      close: true;
      status: 'DONE' | 'UNREACHABLE';
      outcome: PostOpCheckOutcomeCode | null;
    };

/**
 * Máquina de estados de un control PENDING al registrar un intento:
 * - «Bien», «Molestias» o «Necesita cita» lo cierran DONE con ese desenlace;
 * - «No contesta» suma un intento; el tercero (`POST_OP_MAX_NO_ANSWER`) lo
 *   cierra como UNREACHABLE («No localizado»), sin desenlace.
 * `previousNoAnswers`: los «No contesta» que ya tenía.
 */
export function decideAttempt(
  previousNoAnswers: number,
  outcome: PostOpAttemptOutcomeCode,
): AttemptDecision {
  if (outcome !== 'NO_ANSWER') {
    return { close: true, status: 'DONE', outcome };
  }
  return previousNoAnswers + 1 >= POST_OP_MAX_NO_ANSWER
    ? { close: true, status: 'UNREACHABLE', outcome: null }
    : { close: false };
}

/** ¿Ve el rol el detalle clínico (procedimiento, intentos, notas, indicaciones)? */
export function seesClinicalDetail(role: ClinicRole): boolean {
  return CLINICAL_ROLES.includes(role);
}

/** Días civiles de retraso (0 si vence hoy o después). */
export function overdueDays(dueOn: string, today: string): number {
  if (dueOn >= today) return 0;
  const ms =
    Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${dueOn}T00:00:00.000Z`);
  return Math.round(ms / 86_400_000);
}

const OUTCOME_TEXT: Record<PostOpAttemptOutcomeCode, string> = {
  FINE: 'Bien',
  DISCOMFORT: 'Molestias',
  NEEDS_APPOINTMENT: 'Necesita cita',
  NO_ANSWER: 'No contesta',
};

export function postOpOutcomeLabel(outcome: PostOpAttemptOutcomeCode): string {
  return OUTCOME_TEXT[outcome];
}

/** Un intento para el texto de la historia. */
export interface HistoryAttempt {
  outcome: PostOpAttemptOutcomeCode;
  note: string | null;
  byName: string;
  /** Fecha y hora ya formateadas en la zona de la sede. */
  at: string;
}

/**
 * Texto de la adenda o de la evolución nueva al cerrar el control: el
 * resultado, el procedimiento, la nota del último intento y todos los
 * intentos (quién y cuándo). Sin datos de contacto.
 */
export function postOpHistoryText(input: {
  status: 'DONE' | 'UNREACHABLE';
  outcome: PostOpCheckOutcomeCode | null;
  procedureName: string;
  /** Fecha de la cita del procedimiento ya formateada; null si no hay cita. */
  appointmentDate?: string | null;
  attempts: readonly HistoryAttempt[];
}): string {
  const result =
    input.status === 'UNREACHABLE'
      ? `No localizado tras ${input.attempts.length} intentos de llamada`
      : postOpOutcomeLabel(input.outcome as PostOpCheckOutcomeCode);
  const last = input.attempts[input.attempts.length - 1];
  const lines = [
    `Control postoperatorio por llamada: ${input.procedureName}.`,
    ...(input.appointmentDate
      ? [`Control de la cita del ${input.appointmentDate}.`]
      : []),
    `Resultado: ${result}.`,
  ];
  if (last?.note) lines.push(`Nota: ${last.note}`);
  lines.push('Intentos:');
  for (const [i, a] of input.attempts.entries()) {
    lines.push(
      `${i + 1}. ${a.at} · ${postOpOutcomeLabel(a.outcome)} · ${a.byName}${
        a.note && a !== last ? ` · ${a.note}` : ''
      }`,
    );
  }
  return lines.join('\n');
}
