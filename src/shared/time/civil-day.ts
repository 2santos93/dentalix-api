/**
 * Días civiles (YYYY-MM-DD) en la zona IANA de una sede (DX-097).
 *
 * La caja y el dashboard se consultan por días del CALENDARIO de la sede, pero
 * los abonos se guardan como instantes (UTC). Cortar el día a medianoche UTC
 * deja un abono de las 20:00 en Bogotá (01:00 UTC del día siguiente) fuera de
 * «hoy». Esta es la única traducción día civil ↔ instante del dominio: sin
 * dependencias, con `Intl` (que trae la base de zonas de ICU, DST incluido).
 *
 * Los rangos son SEMIABIERTOS `[start, end)`: `end` es el primer instante del
 * día siguiente, así un día de 23 o 25 horas (cambio de hora) se cubre entero
 * sin solapes ni huecos con el siguiente.
 */

const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface InstantRange {
  /** Primer instante del rango (inclusive). */
  start: Date;
  /** Primer instante FUERA del rango (exclusive). */
  end: Date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Formateador cacheado por zona; lanza `RangeError` si la zona no existe. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Desfase de la zona en `instant`: (hora de pared leída como UTC) − instante. */
function offsetAt(instantMs: number, timeZone: string): number {
  const w = wallClockIn(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** ¿Es `timeZone` una zona IANA que este runtime conoce? */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function assertTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Invalid time zone: ${timeZone}`);
  }
}

/**
 * `value` si es un día civil que EXISTE (`2026-02-30` no: `new Date` lo
 * llevaría en silencio al 2 de marzo), o `null`.
 */
export function parseCivilDate(value: string): string | null {
  const match = CIVIL_DATE_RE.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return value;
}

function requireCivilDate(value: string): [number, number, number] {
  if (parseCivilDate(value) === null) {
    throw new RangeError(`Invalid civil date: ${value}`);
  }
  const [y, m, d] = value.split('-').map(Number);
  return [y, m, d];
}

/** `day` más `days` días de calendario (negativo resta). */
export function addCivilDays(day: string, days: number): string {
  const [y, m, d] = requireCivilDate(day);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Días de calendario de `from` a `to`, contando ambos (`from = to` → 1). */
export function civilDaysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = requireCivilDate(from);
  const [ty, tm, td] = requireCivilDate(to);
  return (
    Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS) +
    1
  );
}

/**
 * Día civil (YYYY-MM-DD) de un instante en una zona IANA. `en-CA` formatea
 * como `2026-10-16`, así que el resultado se compara como texto.
 */
export function civilDateIn(instant: Date, timeZone: string): string {
  const w = wallClockIn(instant, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * Primer instante del día civil `day` en `timeZone`.
 *
 * Se prueban los desfases que la zona tiene alrededor de ese día (antes,
 * durante y después) y se queda el menor candidato que cae a las 00:00 de
 * pared: con la hora repetida de otoño eso es la PRIMERA medianoche. Si la
 * medianoche no existe (zonas que adelantan el reloj a las 00:00, p. ej.
 * America/Santiago), el día empieza en el primer instante cuya fecha de pared
 * ya es `day`, que es el del salto (01:00).
 */
export function zonedStartOfDay(day: string, timeZone: string): Date {
  const [y, m, d] = requireCivilDate(day);
  assertTimeZone(timeZone);
  const wallMidnight = Date.UTC(y, m - 1, d);
  const offsets = new Set(
    [-36, -12, 0, 12, 36].map((h) =>
      offsetAt(wallMidnight + h * HOUR_MS, timeZone),
    ),
  );
  const candidates = [...offsets]
    .map((offset) => wallMidnight - offset)
    .sort((a, b) => a - b);

  const exact = candidates.find((instant) => {
    const w = wallClockIn(new Date(instant), timeZone);
    return (
      w.year === y &&
      w.month === m &&
      w.day === d &&
      w.hour === 0 &&
      w.minute === 0 &&
      w.second === 0
    );
  });
  if (exact !== undefined) return new Date(exact);

  const firstOfDay = candidates.find(
    (instant) => civilDateIn(new Date(instant), timeZone) === day,
  );
  if (firstOfDay === undefined) {
    throw new RangeError(`Cannot resolve start of ${day} in ${timeZone}`);
  }
  return new Date(firstOfDay);
}

/** El día civil `day` en `timeZone` como rango `[start, end)` de instantes. */
export function civilDayRange(day: string, timeZone: string): InstantRange {
  return civilRangeInZone(day, day, timeZone);
}

/**
 * Los días civiles `from`..`to` (AMBOS inclusive) en `timeZone`, como rango
 * `[start, end)`: desde la medianoche de `from` hasta la del día siguiente a
 * `to`, cada una con el desfase que la zona tenga ESE día.
 */
export function civilRangeInZone(
  from: string,
  to: string,
  timeZone: string,
): InstantRange {
  if (civilDaysInclusive(from, to) < 1) {
    throw new RangeError('from must be on or before to');
  }
  return {
    start: zonedStartOfDay(from, timeZone),
    end: zonedStartOfDay(addCivilDays(to, 1), timeZone),
  };
}

/** Un tramo del período: las sedes de UNA zona y sus instantes `[start, end)`. */
export interface ZonedPeriodBranch extends InstantRange {
  timeZone: string;
  locationIds: string[];
}

/**
 * El período `from`..`to` (ambos inclusive) para varias sedes: una rama por
 * zona, con las sedes que la usan. Así la consulta filtra con un
 * `(locationId IN (...) AND paidAt >= start AND paidAt < end)` por ZONA —no
 * por sede ni por fila—, que sirve el índice (tenantId, locationId, paidAt).
 * Orden estable por zona.
 */
export function civilPeriodByZone(
  from: string,
  to: string,
  zoneByLocation: ReadonlyMap<string, string>,
): ZonedPeriodBranch[] {
  const byZone = new Map<string, string[]>();
  for (const [locationId, timeZone] of zoneByLocation) {
    const ids = byZone.get(timeZone) ?? [];
    ids.push(locationId);
    byZone.set(timeZone, ids);
  }
  return [...byZone.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timeZone, locationIds]) => ({
      timeZone,
      locationIds: [...locationIds].sort(),
      ...civilRangeInZone(from, to, timeZone),
    }));
}

/**
 * El instante con que se guarda un pago del que solo se sabe el DÍA (el
 * formulario de abono manda `YYYY-MM-DD`): 12 horas después del inicio de ese
 * día en la zona de la sede — el mediodía, salvo en un día con cambio de hora
 * (11:00 o 13:00). Queda dentro del día civil en esa zona y, para zonas entre
 * UTC−11 y UTC+11, también en el mismo día UTC.
 */
export function civilNoonIn(day: string, timeZone: string): Date {
  return new Date(zonedStartOfDay(day, timeZone).getTime() + 12 * HOUR_MS);
}
