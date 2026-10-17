import type {
  AppointmentReminderSkipReason,
  AppointmentReminderStatus,
  AppointmentStatus,
} from '@prisma/client';
import { REMINDER_CATCH_UP_MS, reminderDueAt } from './reminder-window';

/** Entrega del email en email_outbox (SENDING se ve como PENDING). */
export type ReminderEmailDelivery = 'PENDING' | 'SENT' | 'FAILED';

export interface ReminderRecord {
  leadHours: number;
  appointmentStart: Date;
  status: AppointmentReminderStatus;
  skipReason: AppointmentReminderSkipReason | null;
  sentAt: Date | null;
  emailDelivery: ReminderEmailDelivery | null;
}

/**
 * - SENT: se dejó en el outbox de email (`sentAt`); `emailDelivery` dice si el
 *   proveedor ya lo entregó.
 * - SKIPPED: omitido, con su motivo.
 * - SENDING: el handler lo está entregando.
 * - PENDING: saldrá en `dueAt` (calculado: no hay fila todavía).
 * - MISSED: su hora pasó sin enviarse (la cita se agendó después).
 */
export type ReminderState =
  'SENT' | 'SKIPPED' | 'SENDING' | 'PENDING' | 'MISSED';

export interface ReminderTimelineItem {
  leadHours: number;
  appointmentStart: Date;
  dueAt: Date;
  state: ReminderState;
  sentAt: Date | null;
  skipReason: AppointmentReminderSkipReason | null;
  emailDelivery: ReminderEmailDelivery | null;
  /** false = de una hora anterior de la cita (se reprogramó). */
  current: boolean;
}

export interface ReminderTimelineInput {
  appointment: { start: Date; status: AppointmentStatus; deleted: boolean };
  settings: { enabled: boolean; leadHours: number[] } | null;
  records: ReminderRecord[];
  /**
   * DX-128: la preferencia del paciente (baja o canal distinto de EMAIL)
   * impide el email automático: no queda nada pendiente que mostrar.
   */
  patientBlocked?: boolean;
  now: Date;
}

const ACTIVE: ReadonlySet<AppointmentStatus> = new Set([
  'SCHEDULED',
  'CONFIRMED',
]);

function fromRecord(
  record: ReminderRecord,
  current: boolean,
): ReminderTimelineItem {
  return {
    leadHours: record.leadHours,
    appointmentStart: record.appointmentStart,
    dueAt: reminderDueAt(record.appointmentStart, record.leadHours),
    state: record.status,
    sentAt: record.sentAt,
    skipReason: record.skipReason,
    emailDelivery: record.emailDelivery,
    current,
  };
}

/**
 * Estado de los recordatorios de una cita: lo registrado más lo que falta por
 * salir con los ajustes vigentes de su sede. Primero la hora de inicio
 * vigente (de más a menos antelación); detrás, lo registrado para horas
 * anteriores, de la más reciente a la más antigua.
 */
export function buildReminderTimeline(
  input: ReminderTimelineInput,
): ReminderTimelineItem[] {
  const { appointment, settings, now } = input;
  const startMs = appointment.start.getTime();
  const isCurrent = (r: ReminderRecord) =>
    r.appointmentStart.getTime() === startMs;
  const current = input.records.filter(isCurrent);
  const items = current.map((r) => fromRecord(r, true));

  const live =
    input.patientBlocked !== true &&
    !appointment.deleted &&
    ACTIVE.has(appointment.status) &&
    settings?.enabled;
  if (live) {
    for (const leadHours of settings.leadHours) {
      if (current.some((r) => r.leadHours === leadHours)) continue;
      const dueAt = reminderDueAt(appointment.start, leadHours);
      const missed =
        startMs <= now.getTime() ||
        dueAt.getTime() <= now.getTime() - REMINDER_CATCH_UP_MS;
      items.push({
        leadHours,
        appointmentStart: appointment.start,
        dueAt,
        state: missed ? 'MISSED' : 'PENDING',
        sentAt: null,
        skipReason: null,
        emailDelivery: null,
        current: true,
      });
    }
  }
  items.sort((a, b) => b.leadHours - a.leadHours);

  const previous = input.records
    .filter((r) => !isCurrent(r))
    .sort(
      (a, b) =>
        b.appointmentStart.getTime() - a.appointmentStart.getTime() ||
        b.leadHours - a.leadHours,
    )
    .map((r) => fromRecord(r, false));
  return [...items, ...previous];
}
