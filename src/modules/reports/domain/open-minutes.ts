import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
  zonedWallTime,
} from '../../../shared/time/civil-day';

/** Tramo del horario semanal de la sede, en hora de pared (DX-122). */
export interface WeeklyRange {
  /** 0 = domingo … 6 = sábado. */
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/** Un cierre de toda la sede (bloqueo sin profesional que no admite citas). */
export interface Closure {
  start: Date;
  end: Date;
}

export interface OpenMinutesInput {
  /** Primer día civil (inclusive). */
  from: string;
  /** Último día civil (inclusive). */
  to: string;
  timeZone: string;
  ranges: readonly WeeklyRange[];
  closures: readonly Closure[];
}

const MINUTE_MS = 60_000;

/** Tramos de un día de la semana, ordenados y sin solapes. */
function mergedByWeekday(ranges: readonly WeeklyRange[]): WeeklyRange[][] {
  const byDay: WeeklyRange[][] = Array.from({ length: 7 }, () => []);
  for (const r of [...ranges].sort((a, b) => a.startMinute - b.startMinute)) {
    const day = byDay[r.weekday];
    const last = day[day.length - 1];
    if (last && r.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, r.endMinute);
    } else {
      day.push({ ...r });
    }
  }
  return byDay;
}

function mergedClosures(closures: readonly Closure[]): Closure[] {
  const merged: Closure[] = [];
  for (const c of [...closures].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  )) {
    const last = merged[merged.length - 1];
    if (last && c.start.getTime() <= last.end.getTime()) {
      if (c.end.getTime() > last.end.getTime()) last.end = c.end;
    } else {
      merged.push({ start: c.start, end: c.end });
    }
  }
  return merged;
}

/**
 * Minutos que la sede está abierta en `from`..`to` según su horario semanal
 * (hora de pared de su zona), menos los cierres de toda la sede que caen en
 * horario. Los tramos se cuentan en minutos de pared; solo los días que toca
 * un cierre se pasan a instantes (con la zona de ESE día), así que un período
 * de un año cuesta unas pocas llamadas a `Intl`, no miles.
 */
export function openMinutes(input: OpenMinutesInput): number {
  const byWeekday = mergedByWeekday(input.ranges);
  let total = 0;
  for (let day = input.from; day <= input.to; day = addCivilDays(day, 1)) {
    for (const r of byWeekday[civilWeekday(day)]) {
      total += r.endMinute - r.startMinute;
    }
  }

  for (const closure of mergedClosures(input.closures)) {
    const firstDay = civilDateIn(closure.start, input.timeZone);
    const lastDay = civilDateIn(
      new Date(closure.end.getTime() - 1),
      input.timeZone,
    );
    const start = firstDay < input.from ? input.from : firstDay;
    const end = lastDay > input.to ? input.to : lastDay;
    for (let day = start; day <= end; day = addCivilDays(day, 1)) {
      for (const r of byWeekday[civilWeekday(day)]) {
        const open = zonedWallTime(day, r.startMinute, input.timeZone);
        const close = zonedWallTime(day, r.endMinute, input.timeZone);
        const overlap =
          Math.min(close.getTime(), closure.end.getTime()) -
          Math.max(open.getTime(), closure.start.getTime());
        if (overlap > 0) total -= overlap / MINUTE_MS;
      }
    }
  }
  return Math.max(0, Math.round(total));
}
