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
