import { DentitionEventReason, DentitionType } from '@prisma/client';

/**
 * Dentición de la boca por POSICIÓN (DX-120). Cada una de las 32 posiciones se
 * nombra por su código FDI permanente (11-48); el temporal que la ocupa en la
 * infancia es el mismo código con el cuadrante + 4 (55 ocupa la posición 15).
 * Los molares (posiciones 6-8) no tienen predecesor temporal: en ellos
 * PRIMARY significa "el permanente aún no ha erupcionado" y MIXED no existe.
 *
 * Reglas puras, sin E/S: las usan los casos de uso y sus specs.
 */

export const PERMANENT_POSITIONS: readonly string[] = [1, 2, 3, 4].flatMap(
  (quadrant) =>
    [1, 2, 3, 4, 5, 6, 7, 8].map((position) => `${quadrant}${position}`),
);

export const PERMANENT_POSITION_PATTERN = /^[1-4][1-8]$/;

/** Posición (código FDI permanente) que ocupa un diente FDI válido. */
export function positionOfTooth(toothNumber: string): string {
  const quadrant = Number(toothNumber[0]);
  return quadrant > 4 ? `${quadrant - 4}${toothNumber[1]}` : toothNumber;
}

export function isPrimaryTooth(toothNumber: string): boolean {
  return Number(toothNumber[0]) > 4;
}

/** ¿La posición tiene un temporal que la preceda (incisivos, canino, molares temporales)? */
export function hasPrimaryPredecessor(position: string): boolean {
  return Number(position[1]) <= 5;
}

/**
 * Edad de erupción del permanente, en años cumplidos: [desde, hasta). Antes
 * de `from` la posición es temporal; entre `from` y `to` conviven los dos
 * (mixta); desde `to`, permanente. En los molares, sin predecesor, `from` =
 * `to`. Tabla clínica habitual (rangos de erupción de la ADA redondeados al
 * año): 6-7 primeros molares e incisivos inferiores, 7-9 incisivos
 * superiores y laterales, 9-12 caninos y premolares, 12 segundos molares,
 * 17+ terceros molares.
 */
const ERUPTION_AGE: Record<
  'upper' | 'lower',
  Record<number, [number, number]>
> = {
  upper: {
    1: [7, 8],
    2: [8, 9],
    3: [11, 12],
    4: [10, 11],
    5: [10, 12],
    6: [6, 6],
    7: [12, 12],
    8: [17, 17],
  },
  lower: {
    1: [6, 7],
    2: [7, 8],
    3: [9, 10],
    4: [10, 12],
    5: [11, 12],
    6: [6, 6],
    7: [12, 12],
    8: [17, 17],
  },
};

/** Por debajo de esta edad, toda la boca es temporal. */
export const PRIMARY_UNTIL_AGE = 6;
/** Por encima de esta edad (13 años o más), toda la boca es permanente. */
export const MIXED_UNTIL_AGE = 12;

/**
 * Edad en años cumplidos en el día civil `onDate` (YYYY-MM-DD). Quien nació un
 * 29 de febrero cumple el 1 de marzo en los años no bisiestos.
 */
export function ageInYears(birthDate: string, onDate: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

/** Dentición de una posición según la edad (< 6 temporal, 6-12 tabla, > 12 permanente). */
export function dentitionByAge(position: string, age: number): DentitionType {
  if (age < PRIMARY_UNTIL_AGE) return DentitionType.PRIMARY;
  if (age > MIXED_UNTIL_AGE) return DentitionType.PERMANENT;
  const arch = Number(position[0]) <= 2 ? 'upper' : 'lower';
  const [from, to] = ERUPTION_AGE[arch][Number(position[1])];
  if (age >= to) return DentitionType.PERMANENT;
  if (age >= from) {
    return hasPrimaryPredecessor(position)
      ? DentitionType.MIXED
      : DentitionType.PERMANENT;
  }
  return DentitionType.PRIMARY;
}

/** Resumen de la carta: todas permanentes, todas temporales o mixta. */
export function overallDentition(
  dentitions: readonly DentitionType[],
): DentitionType {
  if (dentitions.every((d) => d === DentitionType.PERMANENT)) {
    return DentitionType.PERMANENT;
  }
  if (dentitions.every((d) => d === DentitionType.PRIMARY)) {
    return DentitionType.PRIMARY;
  }
  return DentitionType.MIXED;
}

/** ¿Se puede registrar en `toothNumber` con su posición en `dentition`? */
export function toothAllowedIn(
  toothNumber: string,
  dentition: DentitionType,
): boolean {
  if (dentition === DentitionType.MIXED) return true;
  return isPrimaryTooth(toothNumber)
    ? dentition === DentitionType.PRIMARY
    : dentition === DentitionType.PERMANENT;
}

export interface DentitionEvent {
  id: string;
  position: string;
  dentition: DentitionType;
  reason: DentitionEventReason;
  recordedAt: Date;
  performedById: string;
}

/** De dónde sale la dentición: un evento, la edad o el valor por defecto (sin edad). */
export type DentitionSource = 'EVENT' | 'AGE' | 'DEFAULT';

export interface PositionDentition {
  position: string;
  dentition: DentitionType;
  source: DentitionSource;
  lastEvent: DentitionEvent | null;
}

export interface DentitionState {
  /** AGE si hay fecha de nacimiento; DEFAULT (permanente) si no. */
  basis: 'AGE' | 'DEFAULT';
  ageYears: number | null;
  overall: DentitionType;
  positions: PositionDentition[];
}

/**
 * Estado de las 32 posiciones en `onDate`: el último evento de cada una (los
 * eventos ya vienen filtrados hasta el corte) o, sin eventos, la edad. Sin
 * fecha de nacimiento, permanente. No escribe nada.
 */
export function resolveDentition(input: {
  birthDate: Date | null;
  onDate: string;
  events: readonly DentitionEvent[];
}): DentitionState {
  const ageYears = input.birthDate
    ? ageInYears(input.birthDate.toISOString().slice(0, 10), input.onDate)
    : null;
  const last = new Map<string, DentitionEvent>();
  for (const event of [...input.events].sort(
    (a, b) =>
      a.recordedAt.getTime() - b.recordedAt.getTime() ||
      a.id.localeCompare(b.id),
  )) {
    last.set(event.position, event);
  }
  const positions = PERMANENT_POSITIONS.map((position): PositionDentition => {
    const event = last.get(position);
    if (event) {
      return {
        position,
        dentition: event.dentition,
        source: 'EVENT',
        lastEvent: event,
      };
    }
    if (ageYears === null) {
      return {
        position,
        dentition: DentitionType.PERMANENT,
        source: 'DEFAULT',
        lastEvent: null,
      };
    }
    return {
      position,
      dentition: dentitionByAge(position, Math.max(ageYears, 0)),
      source: 'AGE',
      lastEvent: null,
    };
  });
  return {
    basis: ageYears === null ? 'DEFAULT' : 'AGE',
    ageYears,
    overall: overallDentition(positions.map((p) => p.dentition)),
    positions,
  };
}
