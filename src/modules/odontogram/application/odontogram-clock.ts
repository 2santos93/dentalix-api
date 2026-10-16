import { BadRequestException } from '@nestjs/common';
import {
  addCivilDays,
  civilDateIn,
  parseCivilDate,
  zonedStartOfDay,
} from '../../../shared/time/civil-day';

/** Reloj inyectable del odontograma (la edad y "hoy" dependen de él). */
export const ODONTOGRAM_CLOCK = Symbol('ODONTOGRAM_CLOCK');
export type OdontogramClock = () => Date;

export interface ClinicDay {
  /** Día civil (YYYY-MM-DD) en la zona de la clínica: `asOf` o hoy. */
  onDate: string;
  /**
   * Con `asOf`: primer instante del día SIGUIENTE en esa zona (corte
   * exclusivo). Sin `asOf`: undefined (todo lo registrado cuenta).
   */
  cutoff?: Date;
}

/**
 * Traduce el `asOf=YYYY-MM-DD` de la carta a una fecha (DX-120) al día civil
 * de la clínica: 400 si no es un día que exista o si es futuro.
 */
export function resolveClinicDay(
  asOf: string | undefined,
  now: Date,
  timeZone: string,
): ClinicDay {
  const today = civilDateIn(now, timeZone);
  if (asOf === undefined) return { onDate: today };
  if (parseCivilDate(asOf) === null) {
    throw new BadRequestException(
      'La fecha de la carta debe tener el formato AAAA-MM-DD y existir en el calendario',
    );
  }
  if (asOf > today) {
    throw new BadRequestException('La fecha de la carta no puede ser futura');
  }
  return {
    onDate: asOf,
    cutoff: zonedStartOfDay(addCivilDays(asOf, 1), timeZone),
  };
}
