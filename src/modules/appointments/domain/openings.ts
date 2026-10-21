import type { ScheduleRange } from '../../location-schedule/application/business-hours';
import {
  intersectRanges,
  type MinuteRange,
} from '../../provider-schedule/domain/provider-availability';
import {
  addCivilDays,
  civilDaysInclusive,
  civilWeekday,
  zonedWallTime,
} from '../../../shared/time/civil-day';

/** Un intervalo `[start, end)` de instantes. */
export interface Interval {
  start: Date;
  end: Date;
}

/** Un hueco libre de la agenda: cabe al menos una cita de la duración pedida. */
export type Opening = Interval;

export interface OpeningsQuery {
  /** Primer día civil (YYYY-MM-DD) en la zona de la sede, incluido. */
  fromDay: string;
  /** Último día civil, incluido. */
  toDay: string;
  /** Zona IANA de la sede: los tramos del horario son hora de pared allí. */
  timeZone: string;
  /** Tramos semanales de la sede (0 = domingo). */
  ranges: readonly ScheduleRange[];
  /** Lo que ocupa: citas del profesional (y del paciente) y bloqueos. */
  busy: readonly Interval[];
  durationMinutes: number;
  /** Nada antes de este instante (se redondea al múltiplo de 5 min siguiente). */
  now: Date;
  /** Como mucho estos huecos; por defecto `MAX_OPENINGS`. */
  limit?: number;
  /**
   * DX-233: tramos del profesional en esta sede cada día (`null` = ese día
   * sin restricción). Se cruzan con los de la sede: solo se proponen huecos
   * donde la sede está abierta Y el profesional trabaja allí. Sin la función,
   * como antes (solo el horario de la sede).
   */
  providerRangesOn?: (day: string) => readonly MinuteRange[] | null;
}

export interface OpeningsResult {
  openings: Opening[];
  /** Había más huecos que `limit`. */
  truncated: boolean;
}

/** Tope de huecos por respuesta (la web enseña los primeros). */
export const MAX_OPENINGS = 200;
/** Rango máximo de días que se puede buscar de una vez. */
export const MAX_OPENINGS_RANGE_DAYS = 31;

const STEP_MS = 5 * 60 * 1000;

function ceilToStep(ms: number): number {
  return Math.ceil(ms / STEP_MS) * STEP_MS;
}

/** `interval` menos los ocupados (ordenados por inicio), en trozos libres. */
function subtract(interval: Interval, busy: readonly Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = interval.start.getTime();
  const end = interval.end.getTime();
  for (const b of busy) {
    const bs = b.start.getTime();
    const be = b.end.getTime();
    if (be <= cursor || bs >= end) continue;
    if (bs > cursor) free.push({ start: new Date(cursor), end: new Date(bs) });
    cursor = Math.max(cursor, be);
    if (cursor >= end) break;
  }
  if (cursor < end) free.push({ start: new Date(cursor), end: new Date(end) });
  return free;
}

/**
 * Huecos libres de un profesional (DX-122, «Buscar hueco»): los tramos del
 * horario de la sede —cruzados con los del profesional en esa sede, DX-233—
 * de cada día del rango —en la zona de la sede, con su
 * cambio de hora— menos lo ocupado (citas y bloqueos), sin el pasado y con
 * el inicio alineado a 5 min. Solo quedan los huecos donde cabe la duración.
 *
 * Puro: sin reloj ni BD (los tests fijan `now`).
 */
export function findOpenings(query: OpeningsQuery): OpeningsResult {
  const limit = query.limit ?? MAX_OPENINGS;
  const durationMs = query.durationMinutes * 60 * 1000;
  const notBefore = ceilToStep(query.now.getTime());
  const busy = [...query.busy].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  const openings: Opening[] = [];
  const days = civilDaysInclusive(query.fromDay, query.toDay);

  for (let i = 0; i < days; i++) {
    const day = addCivilDays(query.fromDay, i);
    const weekday = civilWeekday(day);
    const locationRanges = query.ranges
      .filter((r) => r.weekday === weekday)
      .sort((a, b) => a.startMinute - b.startMinute);
    const providerRanges = query.providerRangesOn?.(day) ?? null;
    const ranges =
      providerRanges === null
        ? locationRanges
        : intersectRanges(locationRanges, providerRanges);
    for (const range of ranges) {
      const open: Interval = {
        start: zonedWallTime(day, range.startMinute, query.timeZone),
        end: zonedWallTime(day, range.endMinute, query.timeZone),
      };
      for (const gap of subtract(open, busy)) {
        const start = Math.max(ceilToStep(gap.start.getTime()), notBefore);
        const end = gap.end.getTime();
        if (end - start < durationMs) continue;
        if (openings.length === limit) return { openings, truncated: true };
        openings.push({ start: new Date(start), end: new Date(end) });
      }
    }
  }
  return { openings, truncated: false };
}
