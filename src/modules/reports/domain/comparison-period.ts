import {
  addCivilDays,
  civilDaysInclusive,
  parseCivilDate,
} from '../../../shared/time/civil-day';

/** Contra qué se compara el período (DX-014). */
export const COMPARE_MODES = ['previous', 'previous_year', 'none'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export interface CivilPeriod {
  /** Primer día civil (inclusive). */
  from: string;
  /** Último día civil (inclusive). */
  to: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * El día civil `years` años después (negativo: antes). El 29 de febrero cae en
 * el 28 si el año de destino no es bisiesto, para no saltar a marzo.
 */
export function shiftCivilYears(day: string, years: number): string {
  if (parseCivilDate(day) === null) {
    throw new RangeError(`Invalid civil date: ${day}`);
  }
  const [y, m, d] = day.split('-').map(Number);
  const year = y + years;
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${pad(year, 4)}-${pad(m)}-${pad(Math.min(d, lastDay))}`;
}

/**
 * El período con el que se compara `from`..`to`:
 *  - `previous`: la misma cantidad de días, inmediatamente antes (el mes de
 *    octubre, 31 días, se compara con los 31 días que acaban el 30/09);
 *  - `previous_year`: las mismas fechas un año antes;
 *  - `none`: ninguno.
 */
export function comparisonPeriod(
  from: string,
  to: string,
  mode: CompareMode,
): CivilPeriod | null {
  if (mode === 'none') return null;
  if (mode === 'previous_year') {
    return { from: shiftCivilYears(from, -1), to: shiftCivilYears(to, -1) };
  }
  const days = civilDaysInclusive(from, to);
  const previousTo = addCivilDays(from, -1);
  return { from: addCivilDays(previousTo, -(days - 1)), to: previousTo };
}
