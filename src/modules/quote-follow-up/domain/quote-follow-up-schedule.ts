import type { ContactChannel } from '@prisma/client';
import {
  addCivilDays,
  civilDateIn,
  civilDaysInclusive,
  zonedWallTime,
} from '../../../shared/time/civil-day';
import { isQuoteExpired } from '../../treatment-plans/domain/quote-validity';
import { MAX_FOLLOW_UP_STEPS } from './quote-follow-up-settings';

/**
 * Planificación del seguimiento automático de un presupuesto presentado
 * (DX-561, D2/D3). Todo puro: las horas y los días son los de la zona de la
 * sede de la presentación; el «hoy» y la franja, los de su reloj de pared.
 */

/** Un paso vencido hace más de estos días sin enviarse ya no sale (TOO_LATE). */
export const TOO_LATE_AFTER_DAYS = 7;

export type FollowUpSkipReason =
  | 'SUPERSEDED'
  | 'TOO_LATE'
  | 'STOPPED_ACCEPTED'
  | 'STOPPED_REJECTED'
  | 'STOPPED_SCHEDULED'
  | 'EXPIRED'
  | 'OPTED_OUT'
  | 'CHANNEL_NONE'
  | 'CHANNEL_WHATSAPP'
  | 'NO_EMAIL'
  | 'NO_CONSENT'
  | 'NO_LINK_HOST'
  | 'NO_PROFESSIONAL';

/**
 * Motivos que cierran la secuencia del grupo: registrada la parada (o el
 * vencimiento), no se evalúa ningún paso más.
 */
export const TERMINAL_REASONS: ReadonlySet<FollowUpSkipReason> = new Set([
  'STOPPED_ACCEPTED',
  'STOPPED_REJECTED',
  'STOPPED_SCHEDULED',
  'EXPIRED',
]);

/** Un paso ya registrado del grupo. */
export interface RecordedStep {
  step: number;
  status: 'SENT' | 'SKIPPED';
  reason: FollowUpSkipReason | null;
}

/** El día civil en que vence el paso `step` (1..n). */
export function stepDueDay(
  presentedDay: string,
  offsetsDays: readonly number[],
  step: number,
): string {
  return addCivilDays(presentedDay, offsetsDays[step - 1]);
}

export interface StepPlan {
  /** El paso que toca ahora (el de mayor índice ya vencido y sin registrar). */
  step: number;
  dueDay: string;
  /** Pasos anteriores sin registrar: se registran SKIPPED / SUPERSEDED. */
  superseded: number[];
  /** Vencido hace más de TOO_LATE_AFTER_DAYS días: SKIPPED / TOO_LATE. */
  tooLate: boolean;
}

/**
 * Qué paso toca hoy (D2). Solo pasos POSTERIORES al último registrado (nunca
 * se vuelve atrás), con los días de los ajustes vigentes: como mucho uno por
 * pasada, el de mayor índice ya vencido; los anteriores sin registrar quedan
 * SUPERSEDED (activar el ajuste no acumula avisos atrasados). `null` = nada
 * que hacer hoy: ningún paso vencido, ya se registraron todos o la secuencia
 * está cerrada.
 */
export function planNextStep(input: {
  presentedDay: string;
  offsetsDays: readonly number[];
  recorded: readonly RecordedStep[];
  today: string;
}): StepPlan | null {
  const { recorded, offsetsDays } = input;
  if (
    recorded.some((r) => r.reason !== null && TERMINAL_REASONS.has(r.reason))
  ) {
    return null;
  }
  const steps = Math.min(offsetsDays.length, MAX_FOLLOW_UP_STEPS);
  const last = recorded.reduce((max, r) => Math.max(max, r.step), 0);
  let target: number | null = null;
  for (let step = last + 1; step <= steps; step++) {
    if (stepDueDay(input.presentedDay, offsetsDays, step) <= input.today) {
      target = step;
    }
  }
  if (target === null) return null;
  const dueDay = stepDueDay(input.presentedDay, offsetsDays, target);
  const superseded: number[] = [];
  for (let step = last + 1; step < target; step++) superseded.push(step);
  const late = civilDaysInclusive(dueDay, input.today) - 1;
  return {
    step: target,
    dueDay,
    superseded,
    tooLate: late > TOO_LATE_AFTER_DAYS,
  };
}

/**
 * ¿Está `now` dentro de la franja [desde, hasta) de la sede, en su hora de
 * pared? Con el cambio de hora la franja sigue siendo la del reloj local.
 */
export function inSendWindow(
  now: Date,
  timeZone: string,
  sendFromHour: number,
  sendUntilHour: number,
): boolean {
  const today = civilDateIn(now, timeZone);
  const from = zonedWallTime(today, sendFromHour * 60, timeZone);
  const until = zonedWallTime(today, sendUntilHour * 60, timeZone);
  return now.getTime() >= from.getTime() && now.getTime() < until.getTime();
}

/** Un plan vivo del grupo (sin borrar y que no es un pendiente de DX-417). */
export interface FollowUpPlanFacts {
  id: string;
  status: string;
  /** DX-379: último día válido (YYYY-MM-DD) o null (nunca vence). */
  quoteValidUntil: string | null;
  presentedAt: Date | null;
  paused: boolean;
  /** Tiene aceptación firmada (DX-012/DX-415). */
  accepted: boolean;
  itemCount: number;
}

export interface FollowUpGroupFacts {
  groupId: string;
  patientId: string;
  /** Sede de la presentación (la del primer plan presentado). */
  locationId: string;
  presentedAt: Date;
  plans: FollowUpPlanFacts[];
  recorded: RecordedStep[];
  /** El paciente tiene una cita futura viva o está en la clínica (DX-040). */
  scheduled: boolean;
}

export interface FollowUpContactFacts {
  contactChannel: ContactChannel;
  reminderOptOutAt: Date | null;
  /** La última fila del consentimiento GENERAL (DX-037) es una revocación. */
  consentRevoked: boolean;
}

/**
 * La regla de los envíos automáticos (DX-128, `emailReminderBlocker`) sin el
 * «sin email»: el aviso puede ir al responsable de un menor, así que el email
 * lo decide `resolveSignatureRecipient` después (NO_EMAIL). Y el
 * consentimiento GENERAL revocado (DX-037): la ausencia de filas no bloquea.
 */
export function contactBlocker(
  contact: FollowUpContactFacts,
): FollowUpSkipReason | null {
  if (contact.reminderOptOutAt) return 'OPTED_OUT';
  if (contact.contactChannel === 'NONE') return 'CHANNEL_NONE';
  if (contact.contactChannel === 'WHATSAPP') return 'CHANNEL_WHATSAPP';
  if (contact.consentRevoked) return 'NO_CONSENT';
  return null;
}

export interface FollowUpSettingsFacts {
  enabled: boolean;
  offsetsDays: readonly number[];
  sendFromHour: number;
  sendUntilHour: number;
  timeZone: string;
}

export type FollowUpNoop =
  | 'DISABLED'
  | 'OUTSIDE_WINDOW'
  | 'NOTHING_DUE'
  | 'PAUSED'
  | 'NOT_OPEN'
  | 'WAITING_APPOINTMENT';

export type FollowUpDecision =
  | { kind: 'NOOP'; why: FollowUpNoop }
  | {
      kind: 'SKIP';
      step: number;
      superseded: number[];
      reason: FollowUpSkipReason;
      planIds: string[];
    }
  | {
      kind: 'SEND';
      step: number;
      superseded: number[];
      /** Las opciones PRESENTED y vigentes que se envían (máx. 3), en orden. */
      planIds: string[];
    };

/**
 * La decisión de un grupo en una pasada (D2/D3), sin el destinatario, el
 * host ni el profesional (los resuelve quien llama, que puede convertir un
 * SEND en SKIP con NO_EMAIL, NO_LINK_HOST o NO_PROFESSIONAL).
 *
 * Paradas (aceptado, todo rechazado, cita agendada): se registran una vez
 * en el paso que ya no sale, SOLO si la secuencia empezó (algún aviso
 * enviado); sin ninguno, el grupo simplemente no entra (y una cita agendada
 * antes del primer aviso solo lo deja en espera). La pausa no consume pasos:
 * no se registra nada. Un presupuesto vencido sí se registra (EXPIRED) y
 * cierra la secuencia.
 */
export function decideFollowUp(input: {
  now: Date;
  group: FollowUpGroupFacts;
  settings: FollowUpSettingsFacts | null;
  contact: FollowUpContactFacts;
}): FollowUpDecision {
  const { now, group, settings } = input;
  if (!settings || !settings.enabled) return { kind: 'NOOP', why: 'DISABLED' };
  const { timeZone } = settings;
  if (
    !inSendWindow(now, timeZone, settings.sendFromHour, settings.sendUntilHour)
  ) {
    return { kind: 'NOOP', why: 'OUTSIDE_WINDOW' };
  }
  const today = civilDateIn(now, timeZone);
  const plan = planNextStep({
    presentedDay: civilDateIn(group.presentedAt, timeZone),
    offsetsDays: settings.offsetsDays,
    recorded: group.recorded,
    today,
  });
  if (!plan) return { kind: 'NOOP', why: 'NOTHING_DUE' };
  const started = group.recorded.some((r) => r.status === 'SENT');
  const skip = (reason: FollowUpSkipReason, planIds: string[] = []) =>
    ({
      kind: 'SKIP',
      step: plan.step,
      superseded: plan.superseded,
      reason,
      planIds,
    }) as const;
  const stop = (reason: FollowUpSkipReason, why: FollowUpNoop) =>
    started ? skip(reason) : ({ kind: 'NOOP', why } as const);

  if (group.plans.some((p) => p.accepted || p.status === 'ACCEPTED')) {
    return stop('STOPPED_ACCEPTED', 'NOT_OPEN');
  }
  const presented = group.plans
    .filter((p) => p.status === 'PRESENTED' && p.itemCount > 0)
    .sort(
      (a, b) =>
        (a.presentedAt?.getTime() ?? 0) - (b.presentedAt?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    );
  if (presented.length === 0) {
    const allRejected =
      group.plans.length > 0 &&
      group.plans.every((p) => p.status === 'REJECTED');
    return allRejected
      ? stop('STOPPED_REJECTED', 'NOT_OPEN')
      : { kind: 'NOOP', why: 'NOT_OPEN' };
  }
  if (group.plans.some((p) => p.paused)) return { kind: 'NOOP', why: 'PAUSED' };
  if (group.scheduled) return stop('STOPPED_SCHEDULED', 'WAITING_APPOINTMENT');

  const live = presented.filter(
    (p) => !isQuoteExpired(p.quoteValidUntil, now, timeZone),
  );
  if (live.length === 0)
    return skip(
      'EXPIRED',
      presented.map((p) => p.id),
    );
  const planIds = live.slice(0, MAX_FOLLOW_UP_STEPS).map((p) => p.id);
  if (plan.tooLate) return skip('TOO_LATE', planIds);

  const blocker = contactBlocker(input.contact);
  if (blocker) return skip(blocker, planIds);
  return {
    kind: 'SEND',
    step: plan.step,
    superseded: plan.superseded,
    planIds,
  };
}
