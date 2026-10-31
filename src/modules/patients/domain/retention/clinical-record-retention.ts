import type { RetentionExtension } from '@prisma/client';

/**
 * Plazo mínimo de conservación por defecto: 15 años desde la última atención.
 * Es un valor prudente (iguala o supera el que exigen muchas normativas
 * sanitarias); cada paciente puede ampliarlo a 30 años o a permanente
 * (`RetentionExtension`). Si la norma local pide más, se amplía por paciente.
 */
export const CLINICAL_RECORD_RETENTION_YEARS = 15;

const YEARS: Record<Exclude<RetentionExtension, 'PERMANENT'>, number> = {
  NONE: CLINICAL_RECORD_RETENTION_YEARS,
  DOUBLE: CLINICAL_RECORD_RETENTION_YEARS * 2,
};

/**
 * Hasta qué día (incluido, medianoche UTC) hay que conservar la historia
 * clínica. Puro: no lee el reloj.
 *
 * - `null`: el paciente no tiene atenciones clínicas; no hay retención.
 * - `'PERMANENT'`: nunca se libera (aunque aún no haya atenciones).
 * - Una fecha: el día civil (UTC) de la última atención + 15 o 30 años. Un 29
 *   de febrero termina el 28 de febrero del año final si no es bisiesto (nunca
 *   salta a marzo: el plazo no se alarga un día por el calendario).
 *
 * El día civil se toma en UTC: una atención a última hora en una sede a UTC−5
 * cae al día siguiente en UTC, lo que solo alarga la retención un día — el
 * error va siempre del lado de conservar.
 */
export function retentionUntil(
  lastAttentionAt: Date | null,
  extension: RetentionExtension,
): Date | 'PERMANENT' | null {
  if (extension === 'PERMANENT') return 'PERMANENT';
  if (!lastAttentionAt) return null;
  const year = lastAttentionAt.getUTCFullYear() + YEARS[extension];
  const month = lastAttentionAt.getUTCMonth();
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(lastAttentionAt.getUTCDate(), lastDayOfMonth);
  return new Date(Date.UTC(year, month, day));
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
