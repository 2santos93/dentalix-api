import {
  addCivilDays,
  civilDateIn,
  civilDaysInclusive,
  parseCivilDate,
  wallMillisOfDay,
  zonedWallTime,
} from '../../../shared/time/civil-day';

/**
 * DX-562: fechas de una serie de citas («cada N semanas, N veces o hasta una
 * fecha»). Dominio puro: sin BD ni reloj.
 *
 * Cada fecha repite la HORA DE PARED de la cita base en la zona de su sede
 * (la cita de las 10:00 sigue a las 10:00 tras un cambio de hora) y su
 * DURACIÓN (absoluta, en milisegundos). Se suman días de calendario (7 × N),
 * nunca meses: el fin de mes y el año bisiesto no cambian nada. Una hora que
 * no existe ese día (el adelanto de primavera) cae donde la deja
 * `zonedWallTime`: el mismo día civil, una hora antes (02:30 → 01:30); la
 * vista previa enseña la hora real y se puede cambiar.
 */

/** Tope de citas de una serie, la base incluida. */
export const SERIES_MAX_OCCURRENCES = 26;
/** Una serie tiene al menos dos citas (una sola es una cita suelta). */
export const SERIES_MIN_OCCURRENCES = 2;
export const SERIES_MIN_INTERVAL_WEEKS = 1;
export const SERIES_MAX_INTERVAL_WEEKS = 12;

export const SERIES_DATE_MESSAGES = {
  interval: `Repite la cita cada 1 a ${SERIES_MAX_INTERVAL_WEEKS} semanas.`,
  count: `Una serie tiene de ${SERIES_MIN_OCCURRENCES} a ${SERIES_MAX_OCCURRENCES} citas.`,
  countOrUntil: 'Indica cuántas veces se repite la cita o hasta qué fecha.',
  untilInvalid: 'La fecha final de la serie no es un día válido (AAAA-MM-DD).',
  untilBeforeStart:
    'La fecha final de la serie no puede ser anterior a la primera cita.',
  untilTooFar:
    'La fecha final de la serie puede estar como mucho a un año de la primera cita.',
  untilTooMany: `Hasta esa fecha la serie pasaría de ${SERIES_MAX_OCCURRENCES} citas: acorta la fecha final o espacia más las citas.`,
  untilTooFew:
    'Hasta esa fecha la serie tendría una sola cita: elige una fecha final posterior.',
  endBeforeStart: 'La hora de fin debe ser posterior a la de inicio.',
} as const;

/** Una recurrencia que no se puede generar (el caso de uso responde 400). */
export class SeriesRecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesRecurrenceError';
  }
}

export interface SeriesRecurrence {
  intervalWeeks: number;
  /** Número de citas, la base incluida (2–26). Excluye a `until`. */
  count?: number;
  /**
   * Último día civil (AAAA-MM-DD, en la zona de la sede) que puede tener una
   * cita, incluido; como mucho a un año de la base. Excluye a `count`.
   */
  until?: string;
}

export interface SeriesDatesInput extends SeriesRecurrence {
  start: Date;
  end: Date;
  timeZone: string;
}

/** Una fecha de la serie: su posición (1..n) y su franja. */
export interface SeriesSlot {
  index: number;
  start: Date;
  end: Date;
}

const MINUTE_MS = 60_000;

/**
 * La hora de pared `wallMs` (ms desde las 00:00) del día civil `day` en
 * `timeZone`: los minutos con `zonedWallTime` y el resto (segundos) encima.
 */
export function atWallTime(
  day: string,
  wallMs: number,
  timeZone: string,
): Date {
  const minute = Math.floor(wallMs / MINUTE_MS);
  return new Date(
    zonedWallTime(day, minute, timeZone).getTime() +
      (wallMs - minute * MINUTE_MS),
  );
}

/**
 * El mismo día y mes del año siguiente (el 29 de febrero, el 28): el último
 * día que admite `until`.
 */
export function oneYearAfter(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const next = `${String(y + 1).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return parseCivilDate(next) ?? addCivilDays(next.slice(0, 8) + '28', 0);
}

function assertInterval(intervalWeeks: number): void {
  if (
    !Number.isInteger(intervalWeeks) ||
    intervalWeeks < SERIES_MIN_INTERVAL_WEEKS ||
    intervalWeeks > SERIES_MAX_INTERVAL_WEEKS
  ) {
    throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.interval);
  }
}

/** Cuántas citas salen hasta `until` (incluido), o el error en español. */
function countUntil(baseDay: string, until: string, stepDays: number): number {
  if (parseCivilDate(until) === null) {
    throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.untilInvalid);
  }
  if (until < baseDay) {
    throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.untilBeforeStart);
  }
  if (until > oneYearAfter(baseDay)) {
    throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.untilTooFar);
  }
  const count =
    Math.floor((civilDaysInclusive(baseDay, until) - 1) / stepDays) + 1;
  if (count > SERIES_MAX_OCCURRENCES) {
    throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.untilTooMany);
  }
  if (count < SERIES_MIN_OCCURRENCES) {
    throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.untilTooFew);
  }
  return count;
}

/**
 * Las fechas de la serie, la base primero (índice 1). Lanza
 * `SeriesRecurrenceError` si la recurrencia no vale.
 */
export function seriesDates(input: SeriesDatesInput): SeriesSlot[] {
  assertInterval(input.intervalWeeks);
  const duration = input.end.getTime() - input.start.getTime();
  if (!(duration > 0)) {
    throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.endBeforeStart);
  }
  const hasCount = input.count !== undefined && input.count !== null;
  const hasUntil = input.until !== undefined && input.until !== null;
  if (hasCount === hasUntil) {
    throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.countOrUntil);
  }
  const baseDay = civilDateIn(input.start, input.timeZone);
  const wall = wallMillisOfDay(input.start, input.timeZone);
  const stepDays = 7 * input.intervalWeeks;
  let count: number;
  if (hasCount) {
    count = input.count!;
    if (
      !Number.isInteger(count) ||
      count < SERIES_MIN_OCCURRENCES ||
      count > SERIES_MAX_OCCURRENCES
    ) {
      throw new SeriesRecurrenceError(SERIES_DATE_MESSAGES.count);
    }
  } else {
    count = countUntil(baseDay, input.until!, stepDays);
  }
  const slots: SeriesSlot[] = [];
  for (let k = 0; k < count; k++) {
    // La base es tal cual (aunque caiga en la hora repetida del otoño).
    const start =
      k === 0
        ? new Date(input.start.getTime())
        : atWallTime(addCivilDays(baseDay, stepDays * k), wall, input.timeZone);
    slots.push({
      index: k + 1,
      start,
      end: new Date(start.getTime() + duration),
    });
  }
  return slots;
}

/**
 * DX-562 (D6): mover «esta y las siguientes». La cita pivote pasa de
 * `pivotFrom` a `pivotTo`; cada cita de la serie se desplaza los MISMOS días
 * de calendario y toma la NUEVA hora de pared del pivote, en la zona de la
 * sede. La duración la conserva quien llama (la de cada cita).
 */
export function shiftedStart(
  start: Date,
  pivotFrom: Date,
  pivotTo: Date,
  timeZone: string,
): Date {
  const dayDelta =
    civilDaysInclusive(
      civilDateIn(pivotFrom, timeZone),
      civilDateIn(pivotTo, timeZone),
    ) - 1;
  if (start.getTime() === pivotFrom.getTime()) {
    return new Date(pivotTo.getTime());
  }
  return atWallTime(
    addCivilDays(civilDateIn(start, timeZone), dayDelta),
    wallMillisOfDay(pivotTo, timeZone),
    timeZone,
  );
}

/**
 * DX-562: ¿alguna franja de la lista se solapa con otra de la misma lista?
 * Devuelve los índices (de la lista) que chocan con alguna otra. `[s, e)`
 * medio abiertas: dos citas contiguas no chocan.
 */
export function overlappingWithin(
  slots: readonly { start: Date; end: Date }[],
): Set<number> {
  const out = new Set<number>();
  const order = slots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.start.getTime() - b.s.start.getTime());
  for (let a = 0; a < order.length; a++) {
    for (let b = a + 1; b < order.length; b++) {
      if (order[b].s.start.getTime() >= order[a].s.end.getTime()) break;
      out.add(order[a].i);
      out.add(order[b].i);
    }
  }
  return out;
}
