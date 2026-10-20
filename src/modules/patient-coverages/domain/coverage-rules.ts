/**
 * Reglas puras de una cobertura (DX-153). Las comparten el caso de uso (400
 * en español), el DTO y los tests; la BD repite la vigencia como CHECK y la
 * cobertura principal como índice único parcial.
 */
import { parseCivilDate } from '../../../shared/time/civil-day';

export const MAX_COVERAGES_PER_PATIENT = 5;

export const PLAN_NAME_MAX = 120;
export const MEMBER_NUMBER_MAX = 60;
export const POLICY_HOLDER_NAME_MAX = 200;
export const COVERAGE_NOTES_MAX = 500;

export const PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado.';
export const COVERAGE_NOT_FOUND_MESSAGE = 'Cobertura no encontrada.';
export const COVERAGE_LIMIT_MESSAGE = 'Un paciente admite hasta 5 coberturas.';
export const COVERAGE_DATE_FORMAT_MESSAGE =
  'La fecha debe tener el formato AAAA-MM-DD.';
export const COVERAGE_DATE_RANGE_MESSAGE =
  'La fecha de fin no puede ser anterior a la de inicio.';
export const COVERAGE_PRIMARY_REQUIRED_MESSAGE =
  'Debe haber una cobertura principal; marca otra como principal.';
export const PAYER_INACTIVE_MESSAGE = 'Ese pagador está desactivado.';

export type CoverageStatus = 'ACTIVE' | 'EXPIRED' | 'NOT_STARTED';

/**
 * Estado a un día civil: `EXPIRED` si `validTo < hoy`, `NOT_STARTED` si
 * `validFrom > hoy`, `ACTIVE` el resto (vigencia indefinida incluida). Los
 * extremos cuentan como vigentes. Compara texto `YYYY-MM-DD`, que ordena igual
 * que el calendario.
 */
export function coverageStatus(
  c: { validFrom: string | null; validTo: string | null },
  today: string,
): CoverageStatus {
  if (c.validTo !== null && c.validTo < today) return 'EXPIRED';
  if (c.validFrom !== null && c.validFrom > today) return 'NOT_STARTED';
  return 'ACTIVE';
}

/**
 * Mensaje de error de la vigencia, o `null` si vale: cada fecha debe ser un
 * día que exista y el fin no puede ser anterior al inicio (igual vale).
 */
export function validateCoverageDates(
  from: string | null,
  to: string | null,
): string | null {
  for (const value of [from, to]) {
    if (value !== null && parseCivilDate(value) === null) {
      return COVERAGE_DATE_FORMAT_MESSAGE;
    }
  }
  if (from !== null && to !== null && to < from) {
    return COVERAGE_DATE_RANGE_MESSAGE;
  }
  return null;
}

/** Texto sin espacios de los extremos; vacío = `null`. */
export function normalizeCoverageText(
  value: string | null | undefined,
): string | null {
  return value?.trim() || null;
}
