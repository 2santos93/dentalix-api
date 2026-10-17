import type {
  AppointmentReminderSkipReason,
  AppointmentStatus,
} from '@prisma/client';

const HOUR_MS = 3_600_000;

/**
 * El barrido (cada 5 min) encola los recordatorios cuya hora cae en los
 * próximos 10 min, con `runAt` en esa hora exacta: dos barridos seguidos se
 * solapan a propósito y la idempotencyKey los deduplica.
 */
export const REMINDER_LOOKAHEAD_MS = 10 * 60_000;
/**
 * Un recordatorio atrasado (worker caído, despliegue) se recupera hasta 1 h
 * después de su hora. Más tarde ya no se manda: una cita agendada 30 min antes
 * no recibe el de 48 h, y uno de 48 h no llega a la vez que el de 2 h.
 */
export const REMINDER_CATCH_UP_MS = 60 * 60_000;

export function reminderDueAt(start: Date, leadHours: number): Date {
  return new Date(start.getTime() - leadHours * HOUR_MS);
}

/** ¿Lo encola el barrido que corre en `now`? */
export function isInSweepWindow(
  start: Date,
  leadHours: number,
  now: Date,
): boolean {
  const due = reminderDueAt(start, leadHours).getTime();
  const t = now.getTime();
  return (
    start.getTime() > t &&
    due <= t + REMINDER_LOOKAHEAD_MS &&
    due > t - REMINDER_CATCH_UP_MS
  );
}

/**
 * Un trabajo por (cita, antelación, hora de inicio): repetir el barrido o
 * correrlo en dos workers no crea otro, y reprogramar la cita da otra clave,
 * así que el recordatorio se recalcula para la hora nueva.
 */
export function reminderIdempotencyKey(
  appointmentId: string,
  leadHours: number,
  start: Date,
): string {
  return `reminder:${appointmentId}:${leadHours}h:${start.toISOString()}`;
}

export type ReminderSkipReason = AppointmentReminderSkipReason;

export interface ReminderDecisionInput {
  appointment: {
    status: AppointmentStatus;
    start: Date;
    deleted: boolean;
  };
  /** Hora de inicio con la que se encoló (la de la clave de idempotencia). */
  expectedStart: Date;
  leadHours: number;
  /** Ajustes VIGENTES de la sede de la cita; null = sin fila (desactivado). */
  settings: { enabled: boolean; leadHours: number[] } | null;
  patientEmail: string | null;
  now: Date;
}

export type ReminderDecision =
  { action: 'SEND' } | { action: 'SKIP'; reason: ReminderSkipReason };

const STATUS_SKIP: Partial<Record<AppointmentStatus, ReminderSkipReason>> = {
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
  NO_SHOW: 'NO_SHOW',
};

/**
 * Lo que decide el handler al ejecutarse, con la cita releída: entre el
 * encolado y la hora del envío pudo cancelarse, reprogramarse, cambiar la
 * sede de ajustes o el paciente quedarse sin email. El orden importa: el
 * primer motivo es el que se registra (el estado de la cita explica más que
 * la falta de email).
 */
export function decideReminder(input: ReminderDecisionInput): ReminderDecision {
  const { appointment, settings } = input;
  if (appointment.deleted) return { action: 'SKIP', reason: 'DELETED' };
  const byStatus = STATUS_SKIP[appointment.status];
  if (byStatus) return { action: 'SKIP', reason: byStatus };
  if (appointment.start.getTime() !== input.expectedStart.getTime()) {
    return { action: 'SKIP', reason: 'RESCHEDULED' };
  }
  if (!settings?.enabled || !settings.leadHours.includes(input.leadHours)) {
    return { action: 'SKIP', reason: 'DISABLED' };
  }
  if (appointment.start.getTime() <= input.now.getTime()) {
    return { action: 'SKIP', reason: 'TOO_LATE' };
  }
  if (!input.patientEmail?.trim()) {
    return { action: 'SKIP', reason: 'NO_EMAIL' };
  }
  return { action: 'SEND' };
}
