/*
 * «Tiempos» (DX-275): espera en sala, retraso de inicio y duración real frente
 * a la programada, por profesional, tipo de cita y semana, y la ocupación
 * histórica de cada profesional. ÚNICA definición de cada cifra: la API la
 * publica tal cual (`definitions`), el CSV la copia y la consulta SQL usa los
 * MISMOS umbrales (`TIMING_THRESHOLDS`) que `classifyTiming`, la versión en
 * TypeScript con la que se prueban las reglas.
 *
 * Las marcas son las del flujo en la clínica (DX-200): `arrivedAt` (llegó; la
 * marque recepción o el propio paciente con «Ya llegué», DX-265: es la misma
 * hora), `seatedAt` (en sillón) y `readyForCheckoutAt` (listo para cobrar).
 * Solo cuentan las citas ATENDIDAS (COMPLETED), vivas, por su inicio
 * programado en la zona horaria de su sede. Sin datos clínicos.
 */

import { addCivilDays, civilWeekday } from '../../../shared/time/civil-day';
import type { CivilPeriod } from './comparison-period';
import {
  openMinutes,
  type Closure,
  type DayRange,
  type WeeklyRange,
} from './open-minutes';
import { holidayDaysIn, type OccupancyHoliday } from './chair-occupancy';

/**
 * Umbrales de coherencia y del aviso por tipo. Una cita con las tres marcas
 * que se sale de ellos es «incoherente» (una marca olvidada o puesta otro
 * día) y se excluye de TODAS las cifras de tiempos, como las que no tienen
 * marcas; las dos se cuentan aparte.
 */
export const TIMING_THRESHOLDS = {
  /** Espera de más de 4 h: casi siempre «En sillón» marcado tarde. */
  maxWaitMinutes: 240,
  /** Sentado más de 12 h antes o después de la hora: marcas de otro día. */
  maxStartGapMinutes: 720,
  /** Menos de 1 min en el sillón: las dos marcas seguidas, sin atención. */
  minDurationMinutes: 1,
  /** Más de 8 h en el sillón (la duración máxima de un tipo de cita). */
  maxDurationMinutes: 480,
  /** Aviso: el tipo dura de media más de un 20 % sobre lo programado… */
  overrunPercent: 20,
  /** …en al menos 10 citas con tiempos válidos. */
  overrunMinAppointments: 10,
} as const;

export type TimingThresholds = typeof TIMING_THRESHOLDS;

/** El período admite como mucho 12 meses (≤ 53 semanas en la tabla). */
export const TIMING_MAX_MONTHS = 12;

/** Cómo queda una cita atendida para el informe. */
export type TimingKind = 'MEASURED' | 'WITHOUT_TIMES' | 'INCOHERENT';

export interface TimingMarks {
  start: Date;
  end: Date;
  arrivedAt: Date | null;
  seatedAt: Date | null;
  readyForCheckoutAt: Date | null;
}

export interface TimingSample {
  kind: TimingKind;
  /** Minutos; null salvo en MEASURED. */
  waitMinutes: number | null;
  startDelayMinutes: number | null;
  durationMinutes: number | null;
  plannedMinutes: number;
}

const MINUTE_MS = 60_000;
const minutes = (a: Date, b: Date) => (a.getTime() - b.getTime()) / MINUTE_MS;

/**
 * La regla de cada cita, la misma que la consulta SQL:
 *  - sin `arrivedAt`, `seatedAt` o `readyForCheckoutAt` → WITHOUT_TIMES;
 *  - espera > 4 h, sentado a más de 12 h de la hora, menos de 1 min o más de
 *    8 h en el sillón, o marcas fuera de orden → INCOHERENT;
 *  - si no, MEASURED con:
 *    espera = sentado − máx(llegada, inicio programado), 0 si se le sentó
 *    antes de la hora (no esperó);
 *    retraso de inicio = sentado − inicio programado (negativo = adelanto);
 *    duración real = listo para cobrar − sentado.
 * La duración programada es la de la cita (fin − inicio), siempre.
 */
export function classifyTiming(
  marks: TimingMarks,
  thresholds: TimingThresholds = TIMING_THRESHOLDS,
): TimingSample {
  const plannedMinutes = minutes(marks.end, marks.start);
  const { arrivedAt, seatedAt, readyForCheckoutAt } = marks;
  if (arrivedAt === null || seatedAt === null || readyForCheckoutAt === null) {
    return {
      kind: 'WITHOUT_TIMES',
      waitMinutes: null,
      startDelayMinutes: null,
      durationMinutes: null,
      plannedMinutes,
    };
  }
  const rawWait = minutes(
    seatedAt,
    arrivedAt.getTime() > marks.start.getTime() ? arrivedAt : marks.start,
  );
  const startDelay = minutes(seatedAt, marks.start);
  const duration = minutes(readyForCheckoutAt, seatedAt);
  const incoherent =
    seatedAt.getTime() < arrivedAt.getTime() ||
    readyForCheckoutAt.getTime() < seatedAt.getTime() ||
    rawWait > thresholds.maxWaitMinutes ||
    Math.abs(startDelay) > thresholds.maxStartGapMinutes ||
    duration < thresholds.minDurationMinutes ||
    duration > thresholds.maxDurationMinutes;
  if (incoherent) {
    return {
      kind: 'INCOHERENT',
      waitMinutes: null,
      startDelayMinutes: null,
      durationMinutes: null,
      plannedMinutes,
    };
  }
  return {
    kind: 'MEASURED',
    waitMinutes: Math.max(0, rawWait),
    startDelayMinutes: startDelay,
    durationMinutes: duration,
    plannedMinutes,
  };
}

/**
 * Percentil continuo (interpolación lineal entre los dos valores vecinos),
 * el mismo que `percentile_cont` de Postgres: posición (n − 1)·p sobre los
 * valores ordenados. null sin valores. Es la referencia de los tests: la
 * consulta lo calcula en SQL.
 */
export function percentileCont(
  values: readonly number[],
  fraction: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Lo que la base de datos agrega por grupo (minutos, sin redondear). */
export interface TimingAggregate {
  completed: number;
  measured: number;
  withoutTimes: number;
  incoherent: number;
  waitAvg: number | null;
  waitP90: number | null;
  startDelayAvg: number | null;
  startDelayP90: number | null;
  durationAvg: number | null;
  durationP90: number | null;
  /** Media de la programada de las MEDIDAS (para compararla con la real). */
  plannedAvg: number | null;
}

/** Las cifras de una fila del informe, en minutos con 1 decimal. */
export interface TimingFigures {
  /** Citas atendidas del período. */
  completed: number;
  /** Con tiempos válidos: las únicas que entran en medias y p90. */
  measured: number;
  /** Atendidas sin alguna de las tres marcas. */
  withoutTimes: number;
  /** Con las tres marcas pero fuera de los umbrales. */
  incoherent: number;
  waitAvgMinutes: number | null;
  waitP90Minutes: number | null;
  startDelayAvgMinutes: number | null;
  startDelayP90Minutes: number | null;
  durationAvgMinutes: number | null;
  durationP90Minutes: number | null;
  plannedAvgMinutes: number | null;
  /**
   * (duración real media − programada media) ÷ programada media × 100, con
   * 1 decimal; negativo = se termina antes. null sin citas medidas.
   */
  durationVsPlannedPercent: number | null;
}

export const EMPTY_TIMING_AGGREGATE: TimingAggregate = {
  completed: 0,
  measured: 0,
  withoutTimes: 0,
  incoherent: 0,
  waitAvg: null,
  waitP90: null,
  startDelayAvg: null,
  startDelayP90: null,
  durationAvg: null,
  durationP90: null,
  plannedAvg: null,
};

/** 1 decimal; `-0` sale como 0. */
export function round1(value: number | null): number | null {
  if (value === null) return null;
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

export function timingFigures(a: TimingAggregate): TimingFigures {
  const deviation =
    a.durationAvg !== null && a.plannedAvg !== null && a.plannedAvg > 0
      ? ((a.durationAvg - a.plannedAvg) / a.plannedAvg) * 100
      : null;
  return {
    completed: a.completed,
    measured: a.measured,
    withoutTimes: a.withoutTimes,
    incoherent: a.incoherent,
    waitAvgMinutes: round1(a.waitAvg),
    waitP90Minutes: round1(a.waitP90),
    startDelayAvgMinutes: round1(a.startDelayAvg),
    startDelayP90Minutes: round1(a.startDelayP90),
    durationAvgMinutes: round1(a.durationAvg),
    durationP90Minutes: round1(a.durationP90),
    plannedAvgMinutes: round1(a.plannedAvg),
    durationVsPlannedPercent: round1(deviation),
  };
}

/**
 * Aviso del tipo de cita: con al menos 10 citas medidas, la duración real
 * media supera la programada media en más de un 20 %. Solo para citas con
 * tipo (es la duración que el doctor ajusta en el catálogo, DX-121).
 */
export function exceedsPlanned(
  figures: TimingFigures,
  hasType: boolean,
  thresholds: TimingThresholds = TIMING_THRESHOLDS,
): boolean {
  if (!hasType) return false;
  if (figures.measured < thresholds.overrunMinAppointments) return false;
  // Se compara sin redondear el porcentaje a la baja: 20,04 % no avisa.
  return (
    figures.durationVsPlannedPercent !== null &&
    figures.durationVsPlannedPercent > thresholds.overrunPercent
  );
}

/* ------------------------------------------------------------------------ */
/* Semanas                                                                  */
/* ------------------------------------------------------------------------ */

export interface TimingWeek {
  /** Lunes de la semana (AAAA-MM-DD). */
  weekStart: string;
  /** Primer y último día de la semana DENTRO del período. */
  from: string;
  to: string;
}

/** El lunes de la semana de `day` (semanas de lunes a domingo). */
export function mondayOf(day: string): string {
  const weekday = civilWeekday(day); // 0 = domingo
  return addCivilDays(day, weekday === 0 ? -6 : 1 - weekday);
}

/** Las semanas (lunes a domingo) que toca el período, recortadas a él. */
export function weeksOf(period: CivilPeriod): TimingWeek[] {
  const out: TimingWeek[] = [];
  for (
    let monday = mondayOf(period.from);
    monday <= period.to;
    monday = addCivilDays(monday, 7)
  ) {
    const sunday = addCivilDays(monday, 6);
    out.push({
      weekStart: monday,
      from: monday < period.from ? period.from : monday,
      to: sunday > period.to ? period.to : sunday,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Ocupación                                                                */
/* ------------------------------------------------------------------------ */

/** El horario de UN profesional en UNA sede (DX-233) y lo que lo recorta. */
export interface ProviderLocationCapacity {
  providerId: string;
  locationId: string;
  timeZone: string;
  /** Tramos semanales vivos; vacío = ese horario no tiene días. */
  ranges: readonly WeeklyRange[];
  /** Excepciones por día civil en esta sede (lista vacía = no trabaja). */
  overrides: ReadonlyMap<string, readonly DayRange[]>;
  /** Sus bloqueos que no admiten citas, de esta sede o de todas (DX-122). */
  blocks: readonly Closure[];
  /** Cierres de toda la sede (bloqueo sin profesional que no admite citas). */
  closures: readonly Closure[];
  /** Festivos de la sede (DX-316): ese día no se trabaja. */
  holidays: readonly OccupancyHoliday[];
}

/**
 * Minutos disponibles del profesional en la sede entre `from` y `to`: su
 * horario (con las excepciones por fecha) menos los festivos de la sede,
 * sus bloqueos y los cierres de la sede. El mismo `openMinutes` que la
 * capacidad de «Comparar sedes».
 */
export function availableMinutes(
  capacity: ProviderLocationCapacity,
  from: string,
  to: string,
): number {
  const overrides = new Map(capacity.overrides);
  // Un festivo manda sobre la excepción: la sede está cerrada.
  for (const day of holidayDaysIn(from, to, capacity.holidays)) {
    overrides.set(day, []);
  }
  return openMinutes({
    from,
    to,
    timeZone: capacity.timeZone,
    ranges: capacity.ranges,
    overrides,
    closures: [...capacity.closures, ...capacity.blocks],
  });
}

/** Minutos de agenda de un profesional en una semana (de la consulta). */
export interface BookedMinutes {
  providerId: string;
  weekStart: string;
  /** Citas vivas no canceladas (cualquier otro estado), por su duración. */
  booked: number;
  /** Las atendidas (COMPLETED). */
  attended: number;
  /** Las «No asistió». */
  noShow: number;
}

export interface OccupancyFigures {
  /** Horario − festivos − bloqueos − cierres. */
  availableMinutes: number;
  bookedMinutes: number;
  attendedMinutes: number;
  noShowMinutes: number;
  /** máx(0, disponibles − citadas) de cada semana, sumado. */
  freeMinutes: number;
  /** atendidas ÷ disponibles × 100 (1 decimal); null sin horario. */
  occupancyPercent: number | null;
}

export interface ProviderOccupancyWeek extends OccupancyFigures {
  weekStart: string;
  from: string;
  to: string;
}

export interface ProviderOccupancy extends OccupancyFigures {
  providerId: string;
  /** Tiene horario (DX-233) en alguna sede del informe. */
  hasSchedule: boolean;
  weeks: ProviderOccupancyWeek[];
}

interface OccupancySums {
  available: number;
  booked: number;
  attended: number;
  noShow: number;
  /** Suma de los libres de cada semana: lo citado de más en una semana no libera otra. */
  free: number;
}

const ZERO_SUMS: OccupancySums = {
  available: 0,
  booked: 0,
  attended: 0,
  noShow: 0,
  free: 0,
};

function addSums(into: OccupancySums, x: OccupancySums): void {
  into.available += x.available;
  into.booked += x.booked;
  into.attended += x.attended;
  into.noShow += x.noShow;
  into.free += x.free;
}

function figuresOf(s: OccupancySums): OccupancyFigures {
  const round = (x: number) => Math.round(x);
  return {
    availableMinutes: round(s.available),
    bookedMinutes: round(s.booked),
    attendedMinutes: round(s.attended),
    noShowMinutes: round(s.noShow),
    freeMinutes: round(s.free),
    occupancyPercent:
      s.available > 0 ? round1((s.attended / s.available) * 100) : null,
  };
}

/**
 * Ocupación histórica por profesional y semana (DX-275): disponibles de su
 * horario en las sedes del informe frente a sus minutos citados, atendidos y
 * de no-show. Un profesional sale si tiene horario en alguna sede o alguna
 * cita en el período; sin horario, la ocupación es null («Sin horario»).
 * La ocupación puede pasar de 100 % si se atiende fuera del horario.
 */
export function buildOccupancy(
  period: CivilPeriod,
  capacities: readonly ProviderLocationCapacity[],
  booked: readonly BookedMinutes[],
): { professionals: ProviderOccupancy[]; totals: OccupancyFigures } {
  const weeks = weeksOf(period);
  const providerIds = [
    ...new Set([
      ...capacities.map((c) => c.providerId),
      ...booked.map((b) => b.providerId),
    ]),
  ];
  const bookedBy = new Map(
    booked.map((b) => [`${b.providerId}|${b.weekStart}`, b]),
  );
  const totals: OccupancySums = { ...ZERO_SUMS };
  const professionals = providerIds.map((providerId): ProviderOccupancy => {
    const own = capacities.filter((c) => c.providerId === providerId);
    const sum: OccupancySums = { ...ZERO_SUMS };
    const rows = weeks.map((week): ProviderOccupancyWeek => {
      const available = own.reduce(
        (acc, c) => acc + availableMinutes(c, week.from, week.to),
        0,
      );
      const b = bookedBy.get(`${providerId}|${week.weekStart}`);
      const booked = b?.booked ?? 0;
      const weekSums: OccupancySums = {
        available,
        booked,
        attended: b?.attended ?? 0,
        noShow: b?.noShow ?? 0,
        free: Math.max(0, available - booked),
      };
      addSums(sum, weekSums);
      return { ...week, ...figuresOf(weekSums) };
    });
    addSums(totals, sum);
    return {
      providerId,
      hasSchedule: own.some((c) => c.ranges.length > 0),
      ...figuresOf(sum),
      weeks: rows,
    };
  });
  return { professionals, totals: figuresOf(totals) };
}

/* ------------------------------------------------------------------------ */
/* Definiciones                                                             */
/* ------------------------------------------------------------------------ */

export type TimingDefinitionKey =
  | 'completed'
  | 'withoutTimes'
  | 'incoherent'
  | 'wait'
  | 'startDelay'
  | 'duration'
  | 'planned'
  | 'durationVsPlanned'
  | 'typeOverrun'
  | 'availableMinutes'
  | 'bookedMinutes'
  | 'attendedMinutes'
  | 'noShowMinutes'
  | 'freeMinutes'
  | 'occupancy';

export interface TimingDefinition {
  key: TimingDefinitionKey;
  label: string;
  unit: 'COUNT' | 'MINUTES' | 'PERCENT';
  howItIsCalculated: string;
}

/** Común a todas las cifras de tiempos (va también en el CSV). */
export const TIMING_SCOPE_NOTE =
  'Solo cuentan las citas atendidas (completadas), vivas, por su hora programada en la zona horaria de su sede; las semanas van de lunes a domingo. Las horas de llegada, sillón y listo para cobrar son las del panel «En clínica» (la llegada vale igual si la marcó el paciente con «Ya llegué»). Medias y p90 solo con las citas con tiempos válidos; p90 = el valor por debajo del cual queda el 90 % de esas citas (percentil continuo).';

export function timingDefinitions(
  t: TimingThresholds = TIMING_THRESHOLDS,
): TimingDefinition[] {
  return [
    {
      key: 'completed',
      label: 'Citas atendidas',
      unit: 'COUNT',
      howItIsCalculated:
        'Citas completadas del período (canceladas, no asistidas, borradas y las que siguen en curso no cuentan). De ellas, las de tiempos válidos son las que entran en medias y p90.',
    },
    {
      key: 'withoutTimes',
      label: 'Citas sin tiempos',
      unit: 'COUNT',
      howItIsCalculated:
        'Citas atendidas a las que les falta la hora de llegada, de sillón o de listo para cobrar (se completaron sin pasar por todos los pasos del panel «En clínica»). Se excluyen de todas las cifras de tiempos.',
    },
    {
      key: 'incoherent',
      label: 'Citas con tiempos incoherentes',
      unit: 'COUNT',
      howItIsCalculated: `Citas con las tres horas pero imposibles: espera de más de ${t.maxWaitMinutes} min, pasada al sillón a más de ${t.maxStartGapMinutes / 60} h de la hora programada, menos de ${t.minDurationMinutes} min o más de ${t.maxDurationMinutes / 60} h en el sillón, o las horas fuera de orden. Suelen ser un paso marcado tarde o de golpe. Se excluyen de todas las cifras de tiempos.`,
    },
    {
      key: 'wait',
      label: 'Espera en sala',
      unit: 'MINUTES',
      howItIsCalculated:
        'Hora de sillón − la más tardía entre la llegada y la hora programada: quien llega antes de su hora no suma la espera hasta su hora. Si se le pasó al sillón antes de su hora, la espera es 0. Media y p90.',
    },
    {
      key: 'startDelay',
      label: 'Retraso de inicio',
      unit: 'MINUTES',
      howItIsCalculated:
        'Hora de sillón − hora programada. Negativo si se empezó antes de la hora. Media y p90.',
    },
    {
      key: 'duration',
      label: 'Duración real',
      unit: 'MINUTES',
      howItIsCalculated:
        'Hora de listo para cobrar − hora de sillón: el tiempo en el sillón. Media y p90.',
    },
    {
      key: 'planned',
      label: 'Duración programada',
      unit: 'MINUTES',
      howItIsCalculated:
        'Fin − inicio de la cita tal como se agendó (normalmente la duración del tipo de cita), media de las mismas citas con tiempos válidos.',
    },
    {
      key: 'durationVsPlanned',
      label: 'Real frente a programada',
      unit: 'PERCENT',
      howItIsCalculated:
        '(Duración real media − duración programada media) ÷ duración programada media × 100. Positivo: las citas duran más de lo agendado.',
    },
    {
      key: 'typeOverrun',
      label: 'Tipo que se excede',
      unit: 'COUNT',
      howItIsCalculated: `Aviso en un tipo de cita cuando, con al menos ${t.overrunMinAppointments} citas con tiempos válidos, la duración real media supera la programada media en más de un ${t.overrunPercent} %. Las citas sin tipo no avisan.`,
    },
    {
      key: 'availableMinutes',
      label: 'Disponibles',
      unit: 'MINUTES',
      howItIsCalculated:
        'Minutos del horario del profesional en la sede (con sus excepciones por fecha), menos los festivos de la sede, sus bloqueos y los cierres de la sede que no admiten citas (vacaciones, formación…). Sin horario en la sede, 0.',
    },
    {
      key: 'bookedMinutes',
      label: 'Citadas',
      unit: 'MINUTES',
      howItIsCalculated:
        'Duración programada de sus citas vivas no canceladas del período (atendidas, no asistidas y las que siguen agendadas o en curso).',
    },
    {
      key: 'attendedMinutes',
      label: 'Atendidas',
      unit: 'MINUTES',
      howItIsCalculated:
        'Duración programada de sus citas completadas (no depende de que tengan tiempos).',
    },
    {
      key: 'noShowMinutes',
      label: 'No-show',
      unit: 'MINUTES',
      howItIsCalculated:
        'Duración programada de sus citas «No asistió»: tiempo reservado que se perdió.',
    },
    {
      key: 'freeMinutes',
      label: 'Libres',
      unit: 'MINUTES',
      howItIsCalculated:
        'Disponibles − citadas de cada semana, nunca menos de 0 (lo citado de más una semana no libera otra), sumado: horario que nadie reservó.',
    },
    {
      key: 'occupancy',
      label: 'Ocupación',
      unit: 'PERCENT',
      howItIsCalculated:
        'Minutos atendidos ÷ minutos disponibles × 100. Sin horario no se calcula; puede pasar de 100 % si se atiende fuera del horario.',
    },
  ];
}
