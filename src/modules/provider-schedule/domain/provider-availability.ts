import {
  civilDateIn,
  civilWeekday,
  zonedWallTime,
} from '../../../shared/time/civil-day';

/**
 * Horario de cada profesional por sede (DX-233). Puro: sin reloj ni BD.
 *
 * Regla de disponibilidad (`providerWorksAt`):
 * - Profesional SIN horario configurado (ninguna sede) ⇒ sin restricción,
 *   salvo que ese día tenga una excepción en esa sede. Es la compatibilidad:
 *   al desplegar nadie deja de poder agendar.
 * - Con horario: una excepción de ESA sede ESA fecha prevalece (sin tramos =
 *   «no trabaja»); si no la hay, los tramos semanales de esa sede ese día de
 *   la semana (ninguno = no trabaja allí ese día).
 * - La cita tiene que caber COMPLETA en UN tramo, medio abierto `[start,
 *   end)`, en la hora de pared de la sede (con su cambio de hora). Un tramo
 *   nunca pasa de las 24:00, así que una cita que cruza medianoche no cabe.
 *
 * El horario de la SEDE se comprueba aparte (`fitsBusinessHours`).
 */

/** Un tramo en minutos de pared desde las 00:00 (0..1440), `[start, end)`. */
export interface MinuteRange {
  startMinute: number;
  endMinute: number;
}

/** Tramo semanal de un profesional en una sede. */
export interface WeeklyProviderRange extends MinuteRange {
  locationId: string;
  /** 0 = domingo … 6 = sábado. */
  weekday: number;
}

/** Excepción de una fecha civil en una sede; `ranges` vacío = no trabaja. */
export interface ProviderOverride {
  id: string;
  locationId: string;
  /** YYYY-MM-DD en la zona de la sede. */
  date: string;
  ranges: MinuteRange[];
  note: string | null;
}

/** Lo que la regla necesita de un profesional. */
export interface ProviderScheduleSnapshot {
  providerId: string;
  /** Tiene horario semanal en alguna sede. */
  configured: boolean;
  weekly: WeeklyProviderRange[];
  /** Las excepciones del período que se mira (o todas). */
  overrides: ProviderOverride[];
}

/** De dónde salen los tramos de un día en una sede. */
export type DaySource = 'WEEKLY' | 'OVERRIDE';

export interface DayRanges {
  source: DaySource;
  overrideId: string | null;
  ranges: MinuteRange[];
}

/** Tope de tramos por día y sede (semanal y excepción). */
export const MAX_RANGES_PER_DAY = 7;
/** Las excepciones se aceptan hasta dos años por delante. */
export const OVERRIDE_WINDOW_DAYS = 730;
/** Granularidad de los minutos de un tramo. */
export const MINUTE_STEP = 5;

function byStart(a: MinuteRange, b: MinuteRange): number {
  return a.startMinute - b.startMinute || a.endMinute - b.endMinute;
}

/**
 * Tramos del profesional en `locationId` el día civil `day`, o `null` si ese
 * día no tiene restricción (sin horario configurado y sin excepción).
 */
export function providerDayAt(
  snapshot: ProviderScheduleSnapshot,
  locationId: string,
  day: string,
): DayRanges | null {
  const override = snapshot.overrides.find(
    (o) => o.locationId === locationId && o.date === day,
  );
  if (override) {
    return {
      source: 'OVERRIDE',
      overrideId: override.id,
      ranges: [...override.ranges].sort(byStart),
    };
  }
  if (!snapshot.configured) return null;
  const weekday = civilWeekday(day);
  return {
    source: 'WEEKLY',
    overrideId: null,
    ranges: snapshot.weekly
      .filter((r) => r.locationId === locationId && r.weekday === weekday)
      .map(({ startMinute, endMinute }) => ({ startMinute, endMinute }))
      .sort(byStart),
  };
}

/** Atajo: solo los tramos (o `null` = sin restricción). */
export function providerRangesOn(
  snapshot: ProviderScheduleSnapshot,
  locationId: string,
  day: string,
): MinuteRange[] | null {
  return providerDayAt(snapshot, locationId, day)?.ranges ?? null;
}

/**
 * Todas las sedes en las que el profesional tiene algo ese día (semanal o
 * excepción), con sus tramos. Las excepciones «no trabaja» salen con
 * `ranges: []`. Sin horario configurado, solo las excepciones.
 */
export function providerDayAssignments(
  snapshot: ProviderScheduleSnapshot,
  day: string,
): (DayRanges & { locationId: string })[] {
  const locations = new Set<string>();
  for (const o of snapshot.overrides) {
    if (o.date === day) locations.add(o.locationId);
  }
  if (snapshot.configured) {
    const weekday = civilWeekday(day);
    for (const r of snapshot.weekly) {
      if (r.weekday === weekday) locations.add(r.locationId);
    }
  }
  return [...locations].sort().flatMap((locationId) => {
    const dayRanges = providerDayAt(snapshot, locationId, day);
    return dayRanges ? [{ locationId, ...dayRanges }] : [];
  });
}

/**
 * ¿La cita `[start, end)` cabe en el horario del profesional en esa sede?
 * `timeZone` es la zona de la sede.
 */
export function providerWorksAt(
  snapshot: ProviderScheduleSnapshot,
  locationId: string,
  start: Date,
  end: Date,
  timeZone: string,
): boolean {
  const day = civilDateIn(start, timeZone);
  const ranges = providerRangesOn(snapshot, locationId, day);
  if (ranges === null) return true;
  const s = start.getTime();
  const e = end.getTime();
  return ranges.some(
    (r) =>
      s >= zonedWallTime(day, r.startMinute, timeZone).getTime() &&
      e <= zonedWallTime(day, r.endMinute, timeZone).getTime(),
  );
}

/** Intersección de dos listas de tramos (cada una sin solapes internos). */
export function intersectRanges(
  a: readonly MinuteRange[],
  b: readonly MinuteRange[],
): MinuteRange[] {
  const out: MinuteRange[] = [];
  for (const x of a) {
    for (const y of b) {
      const startMinute = Math.max(x.startMinute, y.startMinute);
      const endMinute = Math.min(x.endMinute, y.endMinute);
      if (endMinute > startMinute) out.push({ startMinute, endMinute });
    }
  }
  return out.sort(byStart);
}

/** ¿Se pisan? Medio abierto: contiguos no. */
export function rangesOverlap(a: MinuteRange, b: MinuteRange): boolean {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

const WEEKDAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? String(weekday);
}

function hhmm(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** «08:00–13:00». */
export function describeRange(r: MinuteRange): string {
  return `${hhmm(r.startMinute)}–${hhmm(r.endMinute)}`;
}

/** «08:00–13:00, 15:00–19:00». */
export function describeRanges(ranges: readonly MinuteRange[]): string {
  return [...ranges].sort(byStart).map(describeRange).join(', ');
}

/**
 * Error de forma de un tramo (minutos enteros múltiplos de 5, dentro del día
 * y fin posterior al inicio), o `null` si está bien.
 */
export function rangeShapeError(r: MinuteRange): string | null {
  const ints = Number.isInteger(r.startMinute) && Number.isInteger(r.endMinute);
  if (!ints || r.startMinute < 0 || r.endMinute > 1440) {
    return 'Los minutos de un tramo tienen que ser enteros entre 0 (00:00) y 1440 (24:00).';
  }
  if (r.startMinute % MINUTE_STEP !== 0 || r.endMinute % MINUTE_STEP !== 0) {
    return `Las horas de un tramo van de ${MINUTE_STEP} en ${MINUTE_STEP} minutos (${describeRange(r)}).`;
  }
  if (r.endMinute <= r.startMinute) {
    return `El fin de un tramo tiene que ser posterior a su inicio y no puede pasar de medianoche (${describeRange(r)}).`;
  }
  return null;
}

/** Dos tramos de la MISMA lista que se pisan, o `null`. */
export function firstOverlap(
  ranges: readonly MinuteRange[],
): [MinuteRange, MinuteRange] | null {
  const sorted = [...ranges].sort(byStart);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMinute < sorted[i - 1].endMinute) {
      return [sorted[i - 1], sorted[i]];
    }
  }
  return null;
}

/** Entrada del horario semanal de una sede. */
export interface WeeklyLocationInput {
  locationId: string;
  ranges: { weekday: number; startMinute: number; endMinute: number }[];
}

/**
 * Valida el horario semanal COMPLETO de un profesional (todas sus sedes) y
 * devuelve el primer error en español, o `null`. `nameOf` da el nombre de la
 * sede para el mensaje.
 */
export function weeklyScheduleError(
  locations: readonly WeeklyLocationInput[],
  nameOf: (locationId: string) => string,
): string | null {
  const seen = new Set<string>();
  for (const loc of locations) {
    if (seen.has(loc.locationId)) {
      return `La sede ${nameOf(loc.locationId)} viene dos veces: manda todos sus tramos juntos.`;
    }
    seen.add(loc.locationId);
    for (const r of loc.ranges) {
      if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) {
        return 'El día de la semana tiene que ser un entero de 0 (domingo) a 6 (sábado).';
      }
      const shape = rangeShapeError(r);
      if (shape) return shape;
    }
    for (let weekday = 0; weekday <= 6; weekday++) {
      const day = loc.ranges.filter((r) => r.weekday === weekday);
      if (day.length > MAX_RANGES_PER_DAY) {
        return `Como mucho ${MAX_RANGES_PER_DAY} tramos por día y sede (${weekdayName(weekday)} en ${nameOf(loc.locationId)}).`;
      }
      const overlap = firstOverlap(day);
      if (overlap) {
        return `Hay tramos solapados el ${weekdayName(weekday)} en ${nameOf(loc.locationId)} (${describeRange(overlap[0])} y ${describeRange(overlap[1])}): únelos en uno.`;
      }
    }
  }
  // Entre sedes: el mismo día no puede estar en dos sitios a la vez.
  for (let weekday = 0; weekday <= 6; weekday++) {
    const day = locations.flatMap((loc) =>
      loc.ranges
        .filter((r) => r.weekday === weekday)
        .map((r) => ({ locationId: loc.locationId, range: r })),
    );
    for (let i = 0; i < day.length; i++) {
      for (let j = i + 1; j < day.length; j++) {
        const a = day[i];
        const b = day[j];
        if (a.locationId !== b.locationId && rangesOverlap(a.range, b.range)) {
          return crossLocationMessage(
            `el ${weekdayName(weekday)}`,
            { name: nameOf(a.locationId), range: a.range },
            { name: nameOf(b.locationId), range: b.range },
          );
        }
      }
    }
  }
  return null;
}

/** Mensaje 400 del solape entre dos sedes el mismo día. */
export function crossLocationMessage(
  when: string,
  a: { name: string; range: MinuteRange },
  b: { name: string; range: MinuteRange },
): string {
  return (
    `El tramo ${describeRange(a.range)} en ${a.name} se solapa ${when} con ` +
    `${describeRange(b.range)} en ${b.name}: un profesional no puede estar en dos sedes a la vez.`
  );
}

/**
 * Valida los tramos de una excepción (forma, tope y solapes entre sí), o
 * `null`. Lista vacía = «no trabaja», válida.
 */
export function overrideRangesError(
  ranges: readonly MinuteRange[],
): string | null {
  if (ranges.length > MAX_RANGES_PER_DAY) {
    return `Como mucho ${MAX_RANGES_PER_DAY} tramos en una excepción.`;
  }
  for (const r of ranges) {
    const shape = rangeShapeError(r);
    if (shape) return shape;
  }
  const overlap = firstOverlap(ranges);
  if (overlap) {
    return `Hay tramos solapados en la excepción (${describeRange(overlap[0])} y ${describeRange(overlap[1])}): únelos en uno.`;
  }
  return null;
}

/**
 * Primer solape, en la fecha `day`, entre los tramos de `locationId` (los que
 * se quieren dejar) y lo que el profesional tiene ese día en OTRAS sedes,
 * según `snapshot`. `null` si no hay.
 */
export function crossLocationConflictOn(
  snapshot: ProviderScheduleSnapshot,
  locationId: string,
  day: string,
  ranges: readonly MinuteRange[],
): { otherLocationId: string; mine: MinuteRange; theirs: MinuteRange } | null {
  for (const other of providerDayAssignments(snapshot, day)) {
    if (other.locationId === locationId) continue;
    for (const mine of ranges) {
      const theirs = other.ranges.find((r) => rangesOverlap(r, mine));
      if (theirs) return { otherLocationId: other.locationId, mine, theirs };
    }
  }
  return null;
}
