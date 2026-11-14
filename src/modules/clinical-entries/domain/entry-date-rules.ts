import { civilDateIn } from '../../../shared/time/civil-day';

export const ENTRY_DATE_OTHER_DAY_MESSAGE =
  'La fecha de atención tiene que ser el día de la cita; si no la indicas, se usa ese día';
export const ENTRY_DATE_FUTURE_MESSAGE =
  'La fecha de atención no puede ser una fecha futura';

/**
 * Día civil (YYYY-MM-DD) de una fecha de atención (DX-231). La web manda el día
 * elegido como medianoche UTC (fecha civil, sin hora): ese día se lee en UTC.
 * Un instante con hora (otro cliente) se lee en la zona de la sede.
 */
export function entryCivilDay(entryDate: Date, timeZone: string): string {
  const isCivilDate = entryDate.getTime() % (24 * 60 * 60 * 1000) === 0;
  return civilDateIn(entryDate, isCivilDate ? 'UTC' : timeZone);
}

/** ¿La fecha de atención cae en el día civil de la cita (zona de su sede)? */
export function isAppointmentDay(
  entryDate: Date,
  appointmentStart: Date,
  timeZone: string,
): boolean {
  return (
    entryCivilDay(entryDate, timeZone) ===
    civilDateIn(appointmentStart, timeZone)
  );
}

/** ¿La fecha de atención es posterior a «hoy» en la zona de la sede? */
export function isFutureEntryDate(
  entryDate: Date,
  now: Date,
  timeZone: string,
): boolean {
  return entryCivilDay(entryDate, timeZone) > civilDateIn(now, timeZone);
}
