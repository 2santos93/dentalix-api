import type { RetentionExtension } from '@prisma/client';

/**
 * De qué sale la fecha de fin de una historia (DX-330): el plazo de la clínica,
 * su doble, el plazo anterior de la clínica (`retention_floor_until`) o nunca.
 */
export type RetentionBasis = 'TERM' | 'DOUBLE' | 'PREVIOUS_TERM' | 'PERMANENT';

export interface RetentionEnd {
  until: Date | 'PERMANENT' | null;
  basis: RetentionBasis | null;
}

/**
 * Día civil (UTC) de `from` + `years` años. Un 29 de febrero termina el 28 de
 * febrero del año final si no es bisiesto (nunca salta a marzo: el plazo no se
 * alarga un día por el calendario).
 */
function addCivilYears(from: Date, years: number): Date {
  const year = from.getUTCFullYear() + years;
  const month = from.getUTCMonth();
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(from.getUTCDate(), lastDayOfMonth);
  return new Date(Date.UTC(year, month, day));
}

/**
 * Hasta qué día (incluido, medianoche UTC) hay que conservar la historia
 * clínica. Puro: no lee el reloj.
 *
 * - `until: null`: el paciente no tiene atenciones clínicas; no hay retención.
 * - `until: 'PERMANENT'`: nunca se libera (aunque aún no haya atenciones).
 * - Una fecha: el día civil (UTC) de la última atención + el plazo vigente de
 *   la clínica (`years`), o su doble con DOUBLE, salvo que el suelo que dejó una
 *   reducción del plazo (`floorUntil`) sea posterior.
 *
 * El día civil se toma en UTC: una atención a última hora en una sede a UTC−5
 * cae al día siguiente en UTC, lo que solo alarga la retención un día — el
 * error va siempre del lado de conservar.
 */
export function retentionUntil(
  lastAttentionAt: Date | null,
  extension: RetentionExtension,
  years: number,
  floorUntil: Date | null,
): RetentionEnd {
  if (extension === 'PERMANENT') {
    return { until: 'PERMANENT', basis: 'PERMANENT' };
  }
  if (!lastAttentionAt) {
    // Un suelo sin atención no existe por construcción; si llega, se respeta.
    return floorUntil
      ? { until: floorUntil, basis: 'PREVIOUS_TERM' }
      : { until: null, basis: null };
  }
  const base = floorCandidate(lastAttentionAt, extension, years);
  if (floorUntil && floorUntil.getTime() > base.getTime()) {
    return { until: floorUntil, basis: 'PREVIOUS_TERM' };
  }
  return { until: base, basis: extension === 'DOUBLE' ? 'DOUBLE' : 'TERM' };
}

/**
 * La fecha de fin con un plazo dado, sin suelo: la que una reducción guarda en
 * `retention_floor_until`. PERMANENT cuenta como DOUBLE, para que un paciente
 * que luego baja a NONE conserve una fecha.
 */
export function floorCandidate(
  last: Date,
  extension: RetentionExtension,
  previousYears: number,
): Date {
  const m = extension === 'NONE' ? 1 : 2;
  return addCivilYears(last, m * previousYears);
}

/** Si a `now` la historia sigue en retención (el último día cuenta). */
export function isUnderRetention(
  until: Date | 'PERMANENT' | null,
  now: Date,
): boolean {
  if (until === null) return false;
  if (until === 'PERMANENT') return true;
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return today <= until.getTime();
}

/** `DD/MM/AAAA` de una fecha de retención (formato del mensaje al usuario). */
export function formatRetentionDate(until: Date): string {
  const dd = String(until.getUTCDate()).padStart(2, '0');
  const mm = String(until.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${until.getUTCFullYear()}`;
}
