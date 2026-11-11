import {
  addCivilDays,
  civilRangeInZone,
  civilWeekday,
  zonedWallTime,
} from '../../../shared/time/civil-day';
import {
  openMinutes,
  type Closure,
  type DayRange,
  type WeeklyRange,
} from './open-minutes';

/*
 * «Ocupación por sillón» (DX-481): reglas puras. El repositorio trae, por
 * sede, su horario, cierres, festivos, sillones y citas; aquí se decide qué
 * cuenta.
 *
 * ABIERTOS (por sillón): los minutos del horario semanal de la SEDE en el
 * período (un sillón está abierto cuando la sede lo está), menos los cierres
 * de toda la sede (bloqueo sin profesional que no admite citas, DX-122) y
 * menos los festivos de la sede (DX-316: un festivo es un día cerrado; el
 * recurrente, el mismo día y mes de cada año). Se cuentan con `openMinutes`,
 * el mismo cálculo que la capacidad de «Comparar sedes». Una sede sin tramos
 * en su horario es «sin restricción» en la agenda: aquí no hay base para un
 * porcentaje y los abiertos son `null` («Sin horario»), nunca 24 h.
 *
 * RESERVADOS: los minutos de las citas vivas NO canceladas (cualquier otro
 * estado, también NO_SHOW), recortados al período (días civiles de la zona de
 * la sede) y, si la sede tiene horario, a sus tramos abiertos: una cita fuera
 * de horario no pasa la ocupación por encima de lo abierto. En un sillón los
 * tramos se UNEN (la BD ya impide dos citas vivas no canceladas a la vez en
 * el mismo sillón, `appointments_no_overlap_per_chair`; la unión es la red).
 *
 * ATENDIDOS: lo mismo, solo con las citas COMPLETED. INASISTENCIAS: las
 * NO_SHOW, que cuentan como reservadas y no como atendidas; van aparte.
 *
 * % = minutos ÷ abiertos, de 0 a 1, con tope en 1 (como la ocupación de
 * DX-305): con horario no se puede pasar, pero un cambio de hora (zonas con
 * horario de verano) o un tramo raro no deben dar un 104 %.
 *
 * «Sin sillón»: las citas de la sede sin sillón asignado, en su propia fila.
 * Sus minutos se SUMAN cita a cita (no se unen: dos citas sin sillón a la
 * vez ocupan dos sillones) y no tienen porcentaje: no son un sillón con su
 * propia capacidad. El total de la sede es la suma de sus sillones (abiertos
 * = abiertos por sillón × sillones); la fila «Sin sillón» queda fuera.
 */

const MINUTE_MS = 60_000;

/** Estados que NO reservan el sillón. */
const NOT_RESERVED = new Set(['CANCELLED']);

export interface OccupancyHoliday {
  /** AAAA-MM-DD. */
  date: string;
  /** Cada año ese mes y día. */
  recurring: boolean;
}

export interface OccupancyChair {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
}

export interface OccupancyAppointment {
  id: string;
  chairId: string | null;
  start: Date;
  end: Date;
  /** `AppointmentStatus`. */
  status: string;
}

export interface LocationOccupancyInput {
  /** Primer día civil (inclusive). */
  from: string;
  /** Último día civil (inclusive). */
  to: string;
  timeZone: string;
  /** Tramos semanales vivos de la sede; vacío = sin horario. */
  ranges: readonly WeeklyRange[];
  /** Cierres de toda la sede. */
  closures: readonly Closure[];
  holidays: readonly OccupancyHoliday[];
  chairs: readonly OccupancyChair[];
  /** Citas vivas de la sede que tocan el período (cualquier estado). */
  appointments: readonly OccupancyAppointment[];
}

export interface OccupancyMetrics {
  /** null = la sede no tiene horario (o es la fila «Sin sillón»). */
  openMinutes: number | null;
  reservedMinutes: number;
  attendedMinutes: number;
  noShowMinutes: number;
  /** Citas no canceladas que tocan el período. */
  reservedAppointments: number;
  attendedAppointments: number;
  noShowAppointments: number;
  /** reservados ÷ abiertos, 0..1 con tope en 1; null sin base. */
  reservedRate: number | null;
  /** atendidos ÷ abiertos, 0..1 con tope en 1; null sin base. */
  attendedRate: number | null;
}

export type ChairOccupancy = {
  chairId: string;
  chairName: string;
  active: boolean;
} & OccupancyMetrics;

export interface LocationOccupancy {
  hasSchedule: boolean;
  /** Abiertos de UN sillón (los de la sede); null sin horario. */
  openMinutesPerChair: number | null;
  /** Días del período cerrados por festivo. */
  holidayDays: number;
  chairs: ChairOccupancy[];
  /** null si no hay citas sin sillón. */
  noChair: OccupancyMetrics | null;
  /** Suma de los sillones (sin «Sin sillón»). */
  totals: OccupancyMetrics;
}

export interface Segment {
  start: number;
  end: number;
}

/** Días del período que son festivo de la sede, en orden. */
export function holidayDaysIn(
  from: string,
  to: string,
  holidays: readonly OccupancyHoliday[],
): string[] {
  const oneOff = new Set(
    holidays.filter((h) => !h.recurring).map((h) => h.date),
  );
  const recurring = new Set(
    holidays.filter((h) => h.recurring).map((h) => h.date.slice(5)),
  );
  const days: string[] = [];
  for (let day = from; day <= to; day = addCivilDays(day, 1)) {
    if (oneOff.has(day) || recurring.has(day.slice(5))) days.push(day);
  }
  return days;
}

/** Ordenados y sin solapes (los que se pisan o se tocan, unidos). */
export function unionOf(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    if (s.end <= s.start) continue;
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ start: s.start, end: s.end });
    }
  }
  return out;
}

/** `pieces` menos `cuts` (las dos listas ordenadas y sin solapes). */
function subtract(
  pieces: readonly Segment[],
  cuts: readonly Segment[],
): Segment[] {
  const out: Segment[] = [];
  for (const p of pieces) {
    let start = p.start;
    for (const c of cuts) {
      if (c.end <= start || c.start >= p.end) continue;
      if (c.start > start) out.push({ start, end: c.start });
      start = Math.max(start, c.end);
      if (start >= p.end) break;
    }
    if (start < p.end) out.push({ start, end: p.end });
  }
  return out;
}

/** Longitud de `segment` dentro de `windows` (ordenadas y sin solapes). */
function lengthInside(segment: Segment, windows: readonly Segment[]): number {
  // Primera ventana que termina después del inicio (búsqueda binaria).
  let lo = 0;
  let hi = windows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (windows[mid].end <= segment.start) lo = mid + 1;
    else hi = mid;
  }
  let total = 0;
  for (let i = lo; i < windows.length && windows[i].start < segment.end; i++) {
    total +=
      Math.min(segment.end, windows[i].end) -
      Math.max(segment.start, windows[i].start);
  }
  return total;
}

/**
 * Las ventanas en las que una cita cuenta: con horario, los tramos de cada
 * día no festivo (en instantes, con la zona de ESE día) menos los cierres;
 * sin horario, el período entero.
 */
export function countingWindows(
  input: Pick<
    LocationOccupancyInput,
    'from' | 'to' | 'timeZone' | 'ranges' | 'closures'
  >,
  holidays: ReadonlySet<string>,
): Segment[] {
  const period = civilRangeInZone(input.from, input.to, input.timeZone);
  if (input.ranges.length === 0) {
    return [{ start: period.start.getTime(), end: period.end.getTime() }];
  }
  const raw: Segment[] = [];
  for (let day = input.from; day <= input.to; day = addCivilDays(day, 1)) {
    if (holidays.has(day)) continue;
    const weekday = civilWeekday(day);
    for (const r of input.ranges) {
      if (r.weekday !== weekday) continue;
      raw.push({
        start: zonedWallTime(day, r.startMinute, input.timeZone).getTime(),
        end: zonedWallTime(day, r.endMinute, input.timeZone).getTime(),
      });
    }
  }
  const closures = unionOf(
    input.closures.map((c) => ({
      start: c.start.getTime(),
      end: c.end.getTime(),
    })),
  );
  return subtract(unionOf(raw), closures);
}

const ratio = (minutes: number, open: number | null): number | null =>
  open === null || open <= 0
    ? null
    : Math.round(Math.min(1, minutes / open) * 10_000) / 10_000;

const toMinutes = (ms: number) => Math.round(ms / MINUTE_MS);

function metricsOf(
  appointments: readonly OccupancyAppointment[],
  windows: readonly Segment[],
  open: number | null,
  merge: boolean,
): OccupancyMetrics {
  const reserved = appointments.filter((a) => !NOT_RESERVED.has(a.status));
  const attended = reserved.filter((a) => a.status === 'COMPLETED');
  const noShow = reserved.filter((a) => a.status === 'NO_SHOW');
  const minutes = (list: readonly OccupancyAppointment[]): number => {
    const segments = list.map((a) => ({
      start: a.start.getTime(),
      end: a.end.getTime(),
    }));
    const pieces = merge ? unionOf(segments) : segments;
    return toMinutes(
      pieces.reduce((sum, s) => sum + lengthInside(s, windows), 0),
    );
  };
  const reservedMinutes = minutes(reserved);
  const attendedMinutes = minutes(attended);
  return {
    openMinutes: open,
    reservedMinutes,
    attendedMinutes,
    noShowMinutes: minutes(noShow),
    reservedAppointments: reserved.length,
    attendedAppointments: attended.length,
    noShowAppointments: noShow.length,
    reservedRate: ratio(reservedMinutes, open),
    attendedRate: ratio(attendedMinutes, open),
  };
}

function sumMetrics(
  rows: readonly OccupancyMetrics[],
  open: number | null,
): OccupancyMetrics {
  const sum = (pick: (m: OccupancyMetrics) => number) =>
    rows.reduce((s, m) => s + pick(m), 0);
  const reservedMinutes = sum((m) => m.reservedMinutes);
  const attendedMinutes = sum((m) => m.attendedMinutes);
  return {
    openMinutes: open,
    reservedMinutes,
    attendedMinutes,
    noShowMinutes: sum((m) => m.noShowMinutes),
    reservedAppointments: sum((m) => m.reservedAppointments),
    attendedAppointments: sum((m) => m.attendedAppointments),
    noShowAppointments: sum((m) => m.noShowAppointments),
    reservedRate: ratio(reservedMinutes, open),
    attendedRate: ratio(attendedMinutes, open),
  };
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** La ocupación de una sede: sus sillones, «Sin sillón» y el total. */
export function buildLocationOccupancy(
  input: LocationOccupancyInput,
): LocationOccupancy {
  const holidays = holidayDaysIn(input.from, input.to, input.holidays);
  const holidaySet = new Set(holidays);
  const hasSchedule = input.ranges.length > 0;
  const overrides = new Map<string, readonly DayRange[]>(
    holidays.map((day) => [day, []]),
  );
  const openPerChair = hasSchedule
    ? openMinutes({
        from: input.from,
        to: input.to,
        timeZone: input.timeZone,
        ranges: input.ranges,
        overrides,
        closures: input.closures,
      })
    : null;
  const windows = countingWindows(input, holidaySet);
  const period = civilRangeInZone(input.from, input.to, input.timeZone);
  // Solo las citas que tocan el período (el repositorio ya las acota).
  const touching = input.appointments.filter(
    (a) =>
      a.end.getTime() > period.start.getTime() &&
      a.start.getTime() < period.end.getTime(),
  );
  const byChair = new Map<string, OccupancyAppointment[]>();
  const withoutChair: OccupancyAppointment[] = [];
  for (const a of touching) {
    if (a.chairId === null) {
      withoutChair.push(a);
      continue;
    }
    const list = byChair.get(a.chairId) ?? [];
    list.push(a);
    byChair.set(a.chairId, list);
  }
  // Un sillón inactivo solo sale si tuvo citas (no canceladas) en el período.
  const chairs = input.chairs
    .filter(
      (c) =>
        c.active ||
        (byChair.get(c.id) ?? []).some((a) => !NOT_RESERVED.has(a.status)),
    )
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) ||
        byText(a.id, b.id),
    )
    .map((c) => ({
      chairId: c.id,
      chairName: c.name,
      active: c.active,
      ...metricsOf(byChair.get(c.id) ?? [], windows, openPerChair, true),
    }));
  const noChairMetrics = withoutChair.some((a) => !NOT_RESERVED.has(a.status))
    ? metricsOf(withoutChair, windows, null, false)
    : null;
  return {
    hasSchedule,
    openMinutesPerChair: openPerChair,
    holidayDays: holidays.length,
    chairs,
    noChair: noChairMetrics,
    totals: sumMetrics(
      chairs,
      openPerChair === null ? null : openPerChair * chairs.length,
    ),
  };
}
