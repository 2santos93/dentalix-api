import { ageInYears } from '../../../odontogram/domain/dentition';

/*
 * Edad desde la que los avisos y los documentos de cobro van al propio
 * paciente (DX-203): la mayoría de edad de la clínica (`tenants.majorityAge`,
 * DX-328), que fija su administrador. Antes, sus avisos van al responsable.
 */

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
 * servidor) con la mayoría de edad `majorityAge` de la clínica? Quien la
 * cumple hoy ya es adulto hoy. `birthDate` es una fecha civil guardada a
 * medianoche UTC. Sin fecha de nacimiento se trata como adulto: no se
 * adivina la edad.
 */
export function isMinor(
  birthDate: Date | null,
  majorityAge: number,
  today: string,
): boolean {
  if (!birthDate) return false;
  return ageInYears(birthDate.toISOString().slice(0, 10), today) < majorityAge;
}
