import { BadRequestException } from '@nestjs/common';
import type { CurrencyWhitelist } from '../../treatment-plans/domain/ports/currency-whitelist.port';
import { isValidTimeZone } from '../../../shared/time/civil-day';

/**
 * G1 (DX-313/314/315): moneda, zona horaria y formato regional de la sede.
 * Validación compartida por el alta, la edición y el registro. Nada se deduce
 * del país: cada valor lo elige quien crea la sede.
 */

export type RegionalField = 'currency' | 'timeZone' | 'locale';

/** Los tres campos regionales, en el orden en que se validan y se informan. */
export const REGIONAL_FIELDS: readonly RegionalField[] = [
  'currency',
  'timeZone',
  'locale',
];

export interface RegionalInput {
  currency?: string | null;
  timeZone?: string | null;
  locale?: string | null;
}

export interface RegionalSettings {
  currency: string;
  timeZone: string;
  locale: string;
}

/** Primer campo inválido, con el mensaje exacto de la spec §3.1. */
export interface RegionalError {
  field: RegionalField;
  message: string;
}

export const REGIONAL_MESSAGES = {
  currencyMissing: 'Elige la moneda de la sede.',
  currencyUnknown: (code: string) =>
    `La moneda ${code} no está en la lista de monedas admitidas.`,
  timeZoneMissing: 'Elige la zona horaria de la sede.',
  timeZoneUnknown: (zone: string) => `La zona horaria «${zone}» no existe.`,
  localeMissing: 'Elige el formato regional de la sede.',
  localeInvalid: (locale: string) =>
    `El formato regional «${locale}» no es válido.`,
} as const;

/** `null` en currency, timeZone o locale al editar (spec §3.2). */
export const REGIONAL_NULL_MESSAGE =
  'La sede tiene que tener moneda, zona horaria y formato regional.';

export const REGIONAL_CHANGE_MESSAGES = {
  cashOpen:
    'Cierra la caja abierta de la sede antes de cambiar su moneda o su zona horaria.',
  currency: (old: string) =>
    `La sede ya tiene movimientos en ${old}. Cambiar la moneda no convierte esos importes ni los de las listas de precios: confirma el cambio para continuar.`,
  timeZone:
    'Cambiar la zona horaria cambia el día en que caen los movimientos ya registrados en caja e informes. Las citas conservan su hora, pero el horario de la sede y de los profesionales se leerá en la nueva zona. Confirma el cambio para continuar.',
} as const;

/** País de la sede: obligatorio en el alta y el registro (decisión 1). */
export const COUNTRY_MISSING = 'Elige el país de la sede.';

/**
 * 400 con el mensaje exacto y el campo del cuerpo al que se refiere, para que
 * la web lo muestre junto a ese campo.
 */
export function regionalBadRequest(
  field: string,
  message: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message,
    field,
  });
}

/** El CHECK de `locations.locale` admite de 2 a 35 caracteres. */
const LOCALE_MAX_LENGTH = 35;

export function isRegionalError(
  value: RegionalSettings | RegionalError,
): value is RegionalError {
  return 'field' in value && 'message' in value;
}

/**
 * Etiqueta BCP 47 canónica (`ES-mx` → `es-MX`) o null si no es válida o el
 * runtime no la soporta para fechas ni para números.
 */
export function normalizeLocale(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let canonical: string | undefined;
  try {
    [canonical] = Intl.getCanonicalLocales(text);
  } catch {
    return null;
  }
  if (!canonical || canonical.length > LOCALE_MAX_LENGTH) return null;
  if (
    Intl.DateTimeFormat.supportedLocalesOf([canonical]).length === 0 ||
    Intl.NumberFormat.supportedLocalesOf([canonical]).length === 0
  ) {
    return null;
  }
  return canonical;
}

const blank = (value: string | null | undefined): value is null | undefined =>
  value === null || value === undefined || value.trim() === '';

export async function validateCurrency(
  raw: string | null | undefined,
  currencies: CurrencyWhitelist,
): Promise<string | RegionalError> {
  if (blank(raw)) {
    return { field: 'currency', message: REGIONAL_MESSAGES.currencyMissing };
  }
  const currency = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || !(await currencies.has(currency))) {
    return {
      field: 'currency',
      message: REGIONAL_MESSAGES.currencyUnknown(currency),
    };
  }
  return currency;
}

export function validateTimeZone(
  raw: string | null | undefined,
): string | RegionalError {
  if (blank(raw)) {
    return { field: 'timeZone', message: REGIONAL_MESSAGES.timeZoneMissing };
  }
  const timeZone = raw.trim();
  if (!isValidTimeZone(timeZone)) {
    return {
      field: 'timeZone',
      message: REGIONAL_MESSAGES.timeZoneUnknown(timeZone),
    };
  }
  return timeZone;
}

export function validateLocale(
  raw: string | null | undefined,
): string | RegionalError {
  if (blank(raw)) {
    return { field: 'locale', message: REGIONAL_MESSAGES.localeMissing };
  }
  const locale = normalizeLocale(raw);
  if (!locale) {
    return {
      field: 'locale',
      message: REGIONAL_MESSAGES.localeInvalid(raw.trim()),
    };
  }
  return locale;
}

/**
 * Valida los tres campos en el orden moneda, zona, formato y devuelve los
 * valores canónicos (moneda en mayúsculas, locale canonicalizado) o el primer
 * error. La existencia de la moneda se consulta por el puerto
 * `CURRENCY_WHITELIST`.
 */
export async function validateRegionalSettings(
  input: RegionalInput,
  currencies: CurrencyWhitelist,
): Promise<RegionalSettings | RegionalError> {
  const currency = await validateCurrency(input.currency, currencies);
  if (typeof currency !== 'string') return currency;
  const timeZone = validateTimeZone(input.timeZone);
  if (typeof timeZone !== 'string') return timeZone;
  const locale = validateLocale(input.locale);
  if (typeof locale !== 'string') return locale;
  return { currency, timeZone, locale };
}
