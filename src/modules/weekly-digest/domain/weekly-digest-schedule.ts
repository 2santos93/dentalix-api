import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
  zonedWallTime,
} from '../../../shared/time/civil-day';

/** Semana civil de lunes a domingo (YYYY-MM-DD, ambos incluidos). */
export interface DigestWeek {
  weekStart: string;
  weekEnd: string;
}

/** Día y hora elegidos por la clínica (0 = domingo … 6 = sábado; 0..23). */
export interface DigestSchedule {
  weekday: number;
  hour: number;
}

export const WEEKDAY_MIN = 0;
export const WEEKDAY_MAX = 6;
export const HOUR_MIN = 0;
export const HOUR_MAX = 23;

/** El lunes de la semana (lunes a domingo) del día civil `day`. */
export function mondayOf(day: string): string {
  return addCivilDays(day, -((civilWeekday(day) + 6) % 7));
}

/** La semana completa anterior (lunes a domingo) a la del día civil `today`. */
export function previousFullWeek(today: string): DigestWeek {
  const weekStart = addCivilDays(mondayOf(today), -7);
  return { weekStart, weekEnd: addCivilDays(weekStart, 6) };
}

/** La semana anterior a `week`. */
export function weekBefore(week: DigestWeek): DigestWeek {
  return {
    weekStart: addCivilDays(week.weekStart, -7),
    weekEnd: addCivilDays(week.weekEnd, -7),
  };
}

/**
 * El instante de la semana de `today` en que toca enviar: el día elegido
 * (contado desde el lunes, así que el domingo es el último) a la hora elegida
 * en la zona de la sede principal (hora de pared: el cambio de hora no lo
 * mueve).
 */
export function dueInstant(
  today: string,
  schedule: DigestSchedule,
  timeZone: string,
): Date {
  const offset = (schedule.weekday + 6) % 7;
  return zonedWallTime(
    addCivilDays(mondayOf(today), offset),
    schedule.hour * 60,
    timeZone,
  );
}

/**
 * ¿Toca enviar el resumen y de qué semana? (DX-568, D3). La semana es SIEMPRE
 * la completa anterior a la de hoy en la zona de la sede principal, y vence
 * cuando en la semana actual ya pasó el momento elegido. Si el servidor
 * estuvo caído ese momento, sale en cuanto vuelva dentro de la MISMA semana;
 * pasada la semana, la que se envía ya es la siguiente: nunca una de hace
 * dos semanas. `null` = aún no toca.
 */
export function dueDigestWeek(
  now: Date,
  schedule: DigestSchedule,
  timeZone: string,
): DigestWeek | null {
  const today = civilDateIn(now, timeZone);
  if (now.getTime() < dueInstant(today, schedule, timeZone).getTime()) {
    return null;
  }
  return previousFullWeek(today);
}

const MONTHS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sept',
  'oct',
  'nov',
  'dic',
];

const LONG_MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

function parts(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

/** «3 nov–9 nov» (el asunto). */
export function weekShortLabel(week: DigestWeek): string {
  const a = parts(week.weekStart);
  const b = parts(week.weekEnd);
  return `${a.d} ${MONTHS[a.m - 1]}–${b.d} ${MONTHS[b.m - 1]}`;
}

/**
 * «del lunes 3 al domingo 9 de noviembre de 2026»; con meses o años
 * distintos, cada extremo con los suyos.
 */
export function weekLongLabel(week: DigestWeek): string {
  const a = parts(week.weekStart);
  const b = parts(week.weekEnd);
  const end = `${b.d} de ${LONG_MONTHS[b.m - 1]} de ${b.y}`;
  const start =
    a.y !== b.y
      ? `${a.d} de ${LONG_MONTHS[a.m - 1]} de ${a.y}`
      : a.m !== b.m
        ? `${a.d} de ${LONG_MONTHS[a.m - 1]}`
        : `${a.d}`;
  return `del lunes ${start} al domingo ${end}`;
}
