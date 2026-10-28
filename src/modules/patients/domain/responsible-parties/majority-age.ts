import type { ClinicCountry } from '@prisma/client';
import { ageInYears } from '../../../odontogram/domain/dentition';

/**
 * Edad desde la que los avisos y los documentos de cobro van al propio
 * paciente (DX-203), según el país de la sede:
 * - CO: 18 años, la mayoría de edad (Código Civil, art. 34).
 * - ES: 16 años, el «menor maduro» que decide por sí mismo sobre su atención
 *   sanitaria (Ley 41/2002, art. 9.4); antes, sus avisos van al responsable.
 */
export const MAJORITY_AGE: Readonly<Record<ClinicCountry, number>> = {
  CO: 18,
  ES: 16,
};

/** DX-328: valor de plataforma al crear una clínica. */
export const PLATFORM_DEFAULT_MAJORITY_AGE = 18;
/** Límites de la plataforma (CHECK tenants_majority_age_check). */
export const MAJORITY_AGE_MIN = 14;
export const MAJORITY_AGE_MAX = 21;
export const MAJORITY_AGE_MESSAGE =
  'La mayoría de edad tiene que ser un número entero de años entre 14 y 21.';

/** ¿Es una mayoría de edad válida? Entero de años dentro de los límites. */
export function isValidMajorityAge(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MAJORITY_AGE_MIN &&
    value <= MAJORITY_AGE_MAX
  );
}

/**
 * ¿Es menor en `today` (día civil YYYY-MM-DD de la sede, nunca el UTC del
 * servidor)? `birthDate` es una fecha civil guardada a medianoche UTC. Sin
 * fecha de nacimiento se trata como adulto: no se adivina la edad.
 */
export function isMinor(
  birthDate: Date | null,
  country: ClinicCountry,
  today: string,
): boolean {
  if (!birthDate) return false;
  return (
    ageInYears(birthDate.toISOString().slice(0, 10), today) <
    MAJORITY_AGE[country]
  );
}
