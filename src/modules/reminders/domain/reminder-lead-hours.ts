/**
 * Antelaciones de los recordatorios de una sede (DX-026): horas antes del
 * inicio de la cita en que sale cada email. Mismos límites que el CHECK de
 * `location_reminder_settings`; los mensajes son los que ve el ADMIN.
 */
export const MAX_REMINDER_LEADS = 3;
export const MIN_LEAD_HOURS = 1;
/** 7 días. */
export const MAX_LEAD_HOURS = 168;

export const TOO_MANY_LEADS_MESSAGE = `Como máximo ${MAX_REMINDER_LEADS} recordatorios por sede.`;
export const LEAD_RANGE_MESSAGE = `Cada recordatorio debe ser de ${MIN_LEAD_HOURS} a ${MAX_LEAD_HOURS} horas antes (7 días).`;
export const DUPLICATE_LEAD_MESSAGE =
  'No repitas la misma antelación: cada recordatorio sale a una hora distinta.';
export const ENABLED_WITHOUT_LEADS_MESSAGE =
  'Para activar los recordatorios elige al menos una antelación.';

export interface ReminderSettingsInput {
  enabled: boolean;
  leadHours: number[];
}

export function leadHoursError(leadHours: number[]): string | null {
  if (leadHours.length > MAX_REMINDER_LEADS) return TOO_MANY_LEADS_MESSAGE;
  const outOfRange = leadHours.some(
    (h) => !Number.isInteger(h) || h < MIN_LEAD_HOURS || h > MAX_LEAD_HOURS,
  );
  if (outOfRange) return LEAD_RANGE_MESSAGE;
  if (new Set(leadHours).size !== leadHours.length) {
    return DUPLICATE_LEAD_MESSAGE;
  }
  return null;
}

export function settingsError(input: ReminderSettingsInput): string | null {
  const error = leadHoursError(input.leadHours);
  if (error) return error;
  return input.enabled && input.leadHours.length === 0
    ? ENABLED_WITHOUT_LEADS_MESSAGE
    : null;
}

/** De mayor a menor: el orden en que salen. */
export function normalizeLeadHours(leadHours: number[]): number[] {
  return [...leadHours].sort((a, b) => b - a);
}
