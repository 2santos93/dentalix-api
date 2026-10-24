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

/** Un tramo de un día concreto, en minutos de pared. */
export interface DayRange {
  startMinute: number;
  endMinute: number;
}

export interface OpenMinutesInput {
  /** Primer día civil (inclusive). */
  from: string;
  /** Último día civil (inclusive). */
  to: string;
  timeZone: string;
  ranges: readonly WeeklyRange[];
  /**
   * Excepciones por día civil (`YYYY-MM-DD`): ese día mandan SUS tramos en vez
   * de los semanales (lista vacía = no se trabaja). DX-233.
   */
  overrides?: ReadonlyMap<string, readonly DayRange[]>;
  closures: readonly Closure[];
}

const MINUTE_MS = 60_000;

/** Tramos ordenados y sin solapes (los que se pisan, unidos). */
function merged(ranges: readonly DayRange[]): DayRange[] {
  const out: DayRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.startMinute - b.startMinute)) {
    const last = out[out.length - 1];
    if (last && r.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, r.endMinute);
    } else {
      out.push({ startMinute: r.startMinute, endMinute: r.endMinute });
    }
  }
  return out;
}

/** Tramos de cada día de la semana, ordenados y sin solapes. */
function mergedByWeekday(ranges: readonly WeeklyRange[]): DayRange[][] {
  return Array.from({ length: 7 }, (_, weekday) =>
    merged(ranges.filter((r) => r.weekday === weekday)),
  );
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
 * Minutos abiertos en `from`..`to` según un horario semanal (hora de pared de
 * la zona), con sus excepciones por día, menos los cierres que caen en
 * horario. Los tramos se cuentan en minutos de pared; solo los días que toca
 * un cierre se pasan a instantes (con la zona de ESE día), así que un período
 * de un año cuesta unas pocas llamadas a `Intl`, no miles.
 */
export function openMinutes(input: OpenMinutesInput): number {
  const byWeekday = mergedByWeekday(input.ranges);
  const overrides = new Map(
    [...(input.overrides ?? new Map<string, readonly DayRange[]>())].map(
      ([day, ranges]) => [day, merged(ranges)],
    ),
  );
  const rangesOn = (day: string): DayRange[] =>
    overrides.get(day) ?? byWeekday[civilWeekday(day)];

  let total = 0;
  for (let day = input.from; day <= input.to; day = addCivilDays(day, 1)) {
    for (const r of rangesOn(day)) total += r.endMinute - r.startMinute;
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
      for (const r of rangesOn(day)) {
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

/** El horario de UN profesional en UNA sede (DX-233) y sus bloqueos. */
export interface ProviderCapacity {
  /** Tramos semanales del profesional en esta sede. */
  ranges: readonly WeeklyRange[];
  /** Sus excepciones en esta sede, por día civil. */
  overrides: ReadonlyMap<string, readonly DayRange[]>;
  /**
   * Sus bloqueos que no admiten citas (vacaciones, formación… DX-122), de
   * esta sede o de todas.
   */
  blocks: readonly Closure[];
}

export interface CapacityMinutesInput {
  from: string;
  to: string;
  /** Zona de la sede. */
  timeZone: string;
  /** Un elemento por profesional con horario en la sede. */
  providers: readonly ProviderCapacity[];
  /** Cierres de toda la sede (bloqueos sin profesional que no admiten citas). */
  closures: readonly Closure[];
}

/**
 * Capacidad de la sede en `from`..`to` (BE-042, DX-305): la suma, profesional
 * a profesional, de los minutos de SU horario en la sede (con sus excepciones
 * por fecha), menos sus bloqueos y los cierres de la sede. Dos profesionales
 * en paralelo son el doble de capacidad que uno; uno con media jornada, la
 * mitad. `null` = nadie tiene horario en la sede: no hay base para la
 * ocupación.
 */
export function capacityMinutes(input: CapacityMinutesInput): number | null {
  if (input.providers.length === 0) return null;
  return input.providers.reduce(
    (sum, provider) =>
      sum +
      openMinutes({
        from: input.from,
        to: input.to,
        timeZone: input.timeZone,
        ranges: provider.ranges,
        overrides: provider.overrides,
        closures: [...input.closures, ...provider.blocks],
      }),
    0,
  );
}
