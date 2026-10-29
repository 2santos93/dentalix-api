import type { ClinicCountry } from '@prisma/client';
import type { CurrencyWhitelist } from '../../treatment-plans/domain/ports/currency-whitelist.port';
import {
  COUNTRY_MISSING,
  isRegionalError,
  regionalBadRequest,
  validateRegionalSettings,
} from '../../locations/domain/regional-settings';
import type { ClinicLocationSettings } from '../domain/ports/auth-repository.port';

/** Los campos de la primera sede tal como llegan en el registro. */
export interface RegistrationLocationInput {
  locationCountry?: ClinicCountry | null;
  locationCurrency?: string | null;
  locationTimeZone?: string | null;
  locationLocale?: string | null;
  /** G1-B (DX-350). */
  locationHourCycle?: string | null;
}

const FIELD = {
  currency: 'locationCurrency',
  timeZone: 'locationTimeZone',
  locale: 'locationLocale',
  hourCycle: 'locationHourCycle',
} as const;

/**
 * G1 (spec §3.5): la primera sede del registro, con las reglas y los mensajes
 * del alta de sede (§3.1). Sin ninguno de los cinco campos (la forma legada de
 * una web antigua) o con algunos, 400 con el mensaje y el campo del primero que
 * falta o no vale (país, moneda, zona, formato, reloj). G1-B fase 1 (spec
 * §4.3): los cuatro de G1 sin reloj (web de G1) se aceptan con
 * `hourCycle: null`; un reloj solo es 400 con el país.
 */
export async function registrationLocation(
  input: RegistrationLocationInput,
  currencies: CurrencyWhitelist,
): Promise<ClinicLocationSettings> {
  if (!input.locationCountry) {
    throw regionalBadRequest('locationCountry', COUNTRY_MISSING);
  }
  const regional = await validateRegionalSettings(
    {
      currency: input.locationCurrency,
      timeZone: input.locationTimeZone,
      locale: input.locationLocale,
      hourCycle: input.locationHourCycle,
    },
    currencies,
  );
  if (isRegionalError(regional)) {
    throw regionalBadRequest(FIELD[regional.field], regional.message);
  }
  return { country: input.locationCountry, ...regional };
}
