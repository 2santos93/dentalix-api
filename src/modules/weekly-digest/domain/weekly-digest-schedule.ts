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
  return dueDigest(now, schedule, timeZone)?.week ?? null;
}

/** Como `dueDigestWeek`, con el instante en que venció (para el payload). */
export function dueDigest(
  now: Date,
  schedule: DigestSchedule,
  timeZone: string,
): { week: DigestWeek; dueAt: Date } | null {
  const today = civilDateIn(now, timeZone);
  const dueAt = dueInstant(today, schedule, timeZone);
  if (now.getTime() < dueAt.getTime()) return null;
  return { week: previousFullWeek(today), dueAt };
}

/** Plazo para enviar una semana vencida (reintentos, cola atrasada). */
export const DIGEST_LATE_LIMIT_MS = 24 * 60 * 60 * 1000;

/**
 * ¿Se puede enviar `weekStart` ahora? (revisión DX-568, n.º 1) Si el trabajo
 * trae el momento en que venció (`dueAt`, lo pone el barrido), la semana es la
 * de ESE momento, mientras no haya pasado más de un día: un trabajo que venció
 * el domingo a las 23:00 y corre el lunes a las 00:05 envía su semana. Sin
 * `dueAt` (trabajos de antes), la semana anterior a la de hoy. Fuera de eso,
 * `null` (la semana ya no toca).
 */
export function sendableWeek(
  weekStart: string,
  now: Date,
  timeZone: string,
  dueAt: Date | null,
): DigestWeek | null {
  if (
    dueAt &&
    dueAt.getTime() <= now.getTime() &&
    now.getTime() - dueAt.getTime() <= DIGEST_LATE_LIMIT_MS
  ) {
    const week = previousFullWeek(civilDateIn(dueAt, timeZone));
    if (week.weekStart === weekStart) return week;
  }
  const week = previousFullWeek(civilDateIn(now, timeZone));
  return week.weekStart === weekStart ? week : null;
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
