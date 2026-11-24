/*
 * «Retención» (DX-260): cuántos pacientes conserva, gana y pierde la clínica
 * en un período, por sede y profesional. ÚNICA definición de cada cifra: la
 * API la publica tal cual (`definitions`, el tooltip de la web), el CSV la
 * copia y la consulta SQL lee los mismos hechos por paciente que clasifica
 * `classifyRetention`, así que una regla cambia en un solo sitio.
 *
 * Hechos por paciente (los calcula la base de datos, ver
 * `prisma-retention.repository.ts`), solo con citas ATENDIDAS (COMPLETED) y
 * vivas: las canceladas, no asistidas y borradas no cuentan. Los cortes son
 * días civiles en la zona de la sede de cada cita (DX-097):
 *  - `activeAtStart`: alguna atendida en [desde − N meses, desde);
 *  - `activeWindowAtEnd`: alguna en [hasta + 1 − N meses, hasta + 1);
 *  - `seenBefore`: alguna antes de `desde`; `seenInPeriod`: alguna en el período;
 *  - `upcoming`: cita futura agendada (agendada o confirmada con inicio
 *    posterior a ahora, o el paciente ya en la clínica);
 *  - `returnedWithinDays`: otra atendida en los 90 días siguientes a la primera.
 */

import { addCivilDays, zonedStartOfDay } from '../../../shared/time/civil-day';
import { addCivilMonths } from '../../recall/domain/recall-rules';
import type { CivilPeriod } from './comparison-period';
import { percent } from './kpi-definitions';

/** Meses sin cita atendida tras los que un paciente deja de estar activo. */
export const RETENTION_ACTIVE_MONTHS = [12, 18, 24] as const;
export type RetentionActiveMonths = (typeof RETENTION_ACTIVE_MONTHS)[number];
export const RETENTION_DEFAULT_ACTIVE_MONTHS: RetentionActiveMonths = 18;

/** Días tras la primera visita en los que un paciente nuevo debería volver. */
export const NEW_NO_RETURN_DAYS = 90;

/** Las listas que abre cada cifra (`GET /reports/retention/patients`). */
export const RETENTION_SEGMENTS = [
  'active_start',
  'new',
  'lost',
  'active_end',
  'reactivated',
  'new_no_return',
] as const;
export type RetentionSegment = (typeof RETENTION_SEGMENTS)[number];

/** Lo que la base de datos sabe de un paciente en el período. */
export interface RetentionFacts {
  activeAtStart: boolean;
  activeWindowAtEnd: boolean;
  seenBefore: boolean;
  seenInPeriod: boolean;
  /** Solo se calcula para quien puede perderse o es nuevo; si no, false. */
  upcoming: boolean;
  /** Solo se calcula para los nuevos; si no, false. */
  returnedWithinDays: boolean;
}

/** Nuevo: su PRIMERA cita atendida de la historia cae en el período. */
export function isNewPatient(f: RetentionFacts): boolean {
  return f.seenInPeriod && !f.seenBefore;
}

/**
 * Activo al inicio sin ninguna atendida en la ventana que acaba el último día
 * y sin cita futura agendada (una cita agendada lo salva aunque su última
 * atendida sea anterior al corte).
 */
export function isLost(f: RetentionFacts): boolean {
  return f.activeAtStart && !f.activeWindowAtEnd && !f.upcoming;
}

/**
 * Activo al final: alguna atendida en la ventana que acaba el último día, o
 * activo al inicio que no se perdió por tener una cita agendada. Así
 * activos al final = activos al inicio − perdidos + nuevos + recuperados.
 */
export function isActiveAtEnd(f: RetentionFacts): boolean {
  return f.activeWindowAtEnd || (f.activeAtStart && f.upcoming);
}

/** Recuperado: no estaba activo al inicio, ya había venido y volvió. */
export function isReactivated(f: RetentionFacts): boolean {
  return f.seenInPeriod && f.seenBefore && !f.activeAtStart;
}

/** Nuevo sin otra atendida en 90 días tras la primera ni cita agendada. */
export function isNewNoReturn(f: RetentionFacts): boolean {
  return isNewPatient(f) && !f.returnedWithinDays && !f.upcoming;
}

/** Las listas en las que entra un paciente. */
export function classifyRetention(f: RetentionFacts): RetentionSegment[] {
  const out: RetentionSegment[] = [];
  if (f.activeAtStart) out.push('active_start');
  if (isNewPatient(f)) out.push('new');
  if (isLost(f)) out.push('lost');
  if (isActiveAtEnd(f)) out.push('active_end');
  if (isReactivated(f)) out.push('reactivated');
  if (isNewNoReturn(f)) out.push('new_no_return');
  return out;
}

export interface RetentionFigures {
  activeAtStart: number;
  newPatients: number;
  lost: number;
  activeAtEnd: number;
  reactivated: number;
  newNoReturn: number;
  /** ((activos al final − nuevos) ÷ activos al inicio) × 100, 2 decimales; null sin activos al inicio. */
  retentionRate: number | null;
}

export const EMPTY_RETENTION_COUNTS: Omit<RetentionFigures, 'retentionRate'> = {
  activeAtStart: 0,
  newPatients: 0,
  lost: 0,
  activeAtEnd: 0,
  reactivated: 0,
  newNoReturn: 0,
};

const SEGMENT_FIGURE: Record<
  RetentionSegment,
  keyof Omit<RetentionFigures, 'retentionRate'>
> = {
  active_start: 'activeAtStart',
  new: 'newPatients',
  lost: 'lost',
  active_end: 'activeAtEnd',
  reactivated: 'reactivated',
  new_no_return: 'newNoReturn',
};

/** La cifra que forma cada lista (la web abre la lista desde su cifra). */
export function figureOfSegment(
  segment: RetentionSegment,
): keyof Omit<RetentionFigures, 'retentionRate'> {
  return SEGMENT_FIGURE[segment];
}

/** La retención de unas cifras (la fórmula del ticket, sin redondear antes). */
export function retentionRateOf(
  c: Pick<RetentionFigures, 'activeAtStart' | 'activeAtEnd' | 'newPatients'>,
): number | null {
  return percent(c.activeAtEnd - c.newPatients, c.activeAtStart);
}

/** Suma `count` pacientes con esos hechos a las cifras. */
export function addFacts(
  into: Omit<RetentionFigures, 'retentionRate'>,
  facts: RetentionFacts,
  count: number,
): void {
  for (const segment of classifyRetention(facts)) {
    into[SEGMENT_FIGURE[segment]] += count;
  }
}

export function withRate(
  c: Omit<RetentionFigures, 'retentionRate'>,
): RetentionFigures {
  return { ...c, retentionRate: retentionRateOf(c) };
}

/** Los cortes de una sede, como instantes `[inicio, fin)`. */
export interface RetentionBounds {
  /** Primer instante del período (`desde`). */
  periodStart: Date;
  /** Primer instante tras el período (`hasta` + 1). */
  periodEnd: Date;
  /** `desde` − N meses: la ventana de «activo al inicio». */
  startCutoff: Date;
  /** `hasta` + 1 − N meses: la ventana de «activo al final». */
  endCutoff: Date;
}

/**
 * Los cortes del período en la zona de una sede. Los meses son de calendario
 * con el día recortado al último del mes (31/03 − 1 mes = 28/02 o 29/02),
 * como `addCivilMonths`; una cita el mismo día del corte cuenta como activa.
 */
export function retentionBounds(
  period: CivilPeriod,
  activeMonths: RetentionActiveMonths,
  timeZone: string,
): RetentionBounds {
  const dayAfter = addCivilDays(period.to, 1);
  return {
    periodStart: zonedStartOfDay(period.from, timeZone),
    periodEnd: zonedStartOfDay(dayAfter, timeZone),
    startCutoff: zonedStartOfDay(
      addCivilMonths(period.from, -activeMonths),
      timeZone,
    ),
    endCutoff: zonedStartOfDay(
      addCivilMonths(dayAfter, -activeMonths),
      timeZone,
    ),
  };
}

export type RetentionFigureKey =
  keyof Omit<RetentionFigures, 'retentionRate'> | 'retentionRate';

export interface RetentionDefinition {
  key: RetentionFigureKey;
  label: string;
  unit: 'COUNT' | 'PERCENT';
  /** La lista que forma la cifra; null en la retención (no es una lista). */
  segment: RetentionSegment | null;
  /** Texto del tooltip «Cómo se calcula». */
  howItIsCalculated: string;
}

const COMMON =
  'Solo cuentan las citas atendidas (las canceladas, no asistidas y borradas no); no cuentan los pacientes archivados ni los de historia suprimida. Cada paciente se cuenta en la sede y el profesional de su última cita atendida hasta el último día del período. Los días son civiles en la zona horaria de cada sede.';
const FUTURE =
  'cita futura agendada (agendada o confirmada que aún no ha empezado, o el paciente ya en la clínica)';

/** Las definiciones con el umbral de actividad elegido (12, 18 o 24 meses). */
export function retentionDefinitions(
  activeMonths: RetentionActiveMonths,
): RetentionDefinition[] {
  const n = `${activeMonths} meses`;
  return [
    {
      key: 'activeAtStart',
      label: 'Activos al inicio',
      unit: 'COUNT',
      segment: 'active_start',
      howItIsCalculated: `Pacientes con al menos una cita atendida en los ${n} anteriores al primer día del período (una cita el mismo día del corte cuenta). ${COMMON}`,
    },
    {
      key: 'newPatients',
      label: 'Nuevos',
      unit: 'COUNT',
      segment: 'new',
      howItIsCalculated: `Pacientes cuya primera cita atendida de toda su historia cae en el período. ${COMMON}`,
    },
    {
      key: 'lost',
      label: 'Perdidos',
      unit: 'COUNT',
      segment: 'lost',
      howItIsCalculated: `Activos al inicio que no tienen ninguna cita atendida en los ${n} que terminan el último día del período ni una ${FUTURE}. ${COMMON}`,
    },
    {
      key: 'activeAtEnd',
      label: 'Activos al final',
      unit: 'COUNT',
      segment: 'active_end',
      howItIsCalculated: `Pacientes con al menos una cita atendida en los ${n} que terminan el último día del período, más los activos al inicio que no la tienen pero sí una ${FUTURE}. Activos al final = activos al inicio − perdidos + nuevos + recuperados. ${COMMON}`,
    },
    {
      key: 'reactivated',
      label: 'Recuperados',
      unit: 'COUNT',
      segment: 'reactivated',
      howItIsCalculated: `Pacientes que no estaban activos al inicio (más de ${n} sin cita atendida), ya habían venido antes y volvieron con una cita atendida en el período. ${COMMON}`,
    },
    {
      key: 'retentionRate',
      label: 'Retención',
      unit: 'PERCENT',
      segment: null,
      howItIsCalculated: `((Activos al final − nuevos) ÷ activos al inicio) × 100, con 2 decimales; sin activos al inicio no se calcula. Los recuperados cuentan como conservados, así que puede pasar del 100 %. ${COMMON}`,
    },
    {
      key: 'newNoReturn',
      label: 'Nuevos sin regreso',
      unit: 'COUNT',
      segment: 'new_no_return',
      howItIsCalculated: `Nuevos del período sin otra cita atendida en los ${NEW_NO_RETURN_DAYS} días siguientes a la primera ni una ${FUTURE}. Un nuevo de hace menos de ${NEW_NO_RETURN_DAYS} días sin cita agendada ya sale aquí: es a quien conviene llamar. ${COMMON}`,
    },
  ];
}
