import { BadRequestException } from '@nestjs/common';
import type { CountryWhitelist } from './ports/country-whitelist.port';
import type { CurrencyWhitelist } from '../../treatment-plans/domain/ports/currency-whitelist.port';
import { isPhoneRegion } from '../../../shared/phone/phone-number';
import { canonicalTimeZoneName } from '../../../shared/time/canonical-time-zone';
import type { HourCycle } from '../../../shared/format/regional-format';
import {
  HOUR_CYCLES,
  isHourCycle,
} from '../../../shared/locations/location-regional';

/**
 * G1 (DX-313/314/315): moneda, zona horaria y formato regional de la sede;
 * G1-B (DX-350): y su reloj. Validación compartida por el alta, la edición y
 * el registro. Nada se deduce del país: cada valor lo elige quien crea la sede.
 */

export type RegionalField =
  'country' | 'currency' | 'timeZone' | 'locale' | 'hourCycle';

/**
 * Los tres campos de G1, en el orden en que se validan y se informan. El
 * reloj (G1-B) se valida después y queda fuera de esta lista en fase 1: una
 * sede de una réplica de G1 puede no tenerlo (spec G1-B §4.2, pre-flight M6).
 */
export const REGIONAL_FIELDS: readonly RegionalField[] = [
  'currency',
  'timeZone',
  'locale',
];

// G1-B: el reloj de la sede (12 h o 24 h) y su comprobación tienen una sola
// fuente, compartida con los cargadores de sede.
export { HOUR_CYCLES, isHourCycle };
export type { HourCycle };

export interface RegionalInput {
  currency?: string | null;
  timeZone?: string | null;
  locale?: string | null;
  hourCycle?: string | null;
}

export interface RegionalSettings {
  currency: string;
  timeZone: string;
  locale: string;
  /**
   * G1-B fase 1: null = la petición no traía reloj (forma de la web de G1);
   * quien guarda la sede llama a `dx_g1b_backfill_location_hour_cycle` en la
   * misma transacción. Fase 2: obligatorio.
   */
  hourCycle: HourCycle | null;
}

/** Primer campo inválido, con el mensaje exacto de la spec §3.1. */
export interface RegionalError {
  field: RegionalField;
  message: string;
}

/**
 * DX-329: el error de la región telefónica, aparte de `RegionalError`: no es
 * un campo de G1 ni del registro (pre-flight I3), así que `registration-location`
 * no tiene que conocerlo.
 */
export interface DefaultPhoneRegionError {
  field: 'defaultPhoneRegion';
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
  hourCycleMissing: 'Elige el reloj de la sede: 12 h o 24 h.',
  hourCycleInvalid: (hourCycle: string) =>
    `El reloj «${hourCycle}» no es válido: elige 12 h o 24 h.`,
} as const;

/** `null` en currency, timeZone, locale o hourCycle al editar (spec §3.2; G1-B §4.2). */
export const REGIONAL_NULL_MESSAGE =
  'La sede tiene que tener moneda, zona horaria, formato regional y reloj.';

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

/** Un código de dos letras que no está en la tabla `countries`. */
export const COUNTRY_UNKNOWN = (code: string) =>
  `El país «${code}» no está en la lista de países.`;

/** Cualquier otro texto: no se repite lo recibido (puede ser larguísimo). */
export const COUNTRY_INVALID =
  'El país indicado no está en la lista de países.';

/** DX-329: dos letras que la librería de teléfonos no admite como región. */
export const DEFAULT_PHONE_REGION_UNKNOWN = (code: string) =>
  `El prefijo telefónico «${code}» no está en la lista.`;

/** Cualquier otro texto: no se repite lo recibido (puede ser larguísimo). */
export const DEFAULT_PHONE_REGION_INVALID =
  'El prefijo telefónico indicado no está en la lista.';

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
 * G1-B (spec §3.2): quita la palabra clave `hc` de la extensión Unicode de una
 * etiqueta ya canónica (`en-us-u-hc-h12` → `en-US`): el reloj tiene su propio
 * campo y no puede haber dos fuentes. Las demás palabras clave se conservan, y
 * una extensión `-u-` que se queda vacía desaparece.
 */
function withoutHourCycleKeyword(canonical: string): string {
  const subtags = canonical.split('-');
  // En la forma canónica la extensión privada `-x-` va al final: una `u`
  // detrás de ella no es la extensión Unicode.
  const privateUse = subtags.indexOf('x');
  const u = subtags.indexOf('u');
  if (u < 0 || (privateUse >= 0 && privateUse < u)) return canonical;
  let end = u + 1;
  while (end < subtags.length && subtags[end].length > 1) end++;
  const kept: string[] = [];
  let skipping = false;
  for (const subtag of subtags.slice(u + 1, end)) {
    // Clave = 2 caracteres; sus tipos (3-8) la siguen hasta la próxima clave.
    if (subtag.length === 2) skipping = subtag === 'hc';
    if (!skipping) kept.push(subtag);
  }
  const extension = kept.length > 0 ? ['u', ...kept] : [];
  return [...subtags.slice(0, u), ...extension, ...subtags.slice(end)].join(
    '-',
  );
}

/**
 * Etiqueta BCP 47 canónica (`ES-mx` → `es-MX`), sin la palabra clave `hc`
 * (G1-B), o null si no es válida o el runtime no la soporta para fechas ni
 * para números.
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
  if (canonical) canonical = withoutHourCycleKeyword(canonical);
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

/**
 * El país de la sede: código ISO 3166-1 alfa-2, recortado y en mayúsculas, que
 * esté en la tabla `countries`. No mira ningún país concreto ni decide reglas.
 */
export async function validateCountry(
  raw: unknown,
  countries: CountryWhitelist,
): Promise<string | RegionalError> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { field: 'country', message: COUNTRY_MISSING };
  }
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return { field: 'country', message: COUNTRY_INVALID };
  }
  if (!(await countries.has(code))) {
    return { field: 'country', message: COUNTRY_UNKNOWN(code) };
  }
  return code;
}

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

/**
 * La zona, canónica, si está en la lista IANA. `stored` es la zona ya guardada
 * de la sede (PATCH): G1 aceptaba toda la que `Intl` acepta (`+05:00`) y la
 * web la reenvía en cada guardado, así que la misma zona (sin distinguir
 * mayúsculas) se devuelve tal cual está guardada en vez de rechazarla, para
 * no bloquear el resto de la sede. Una zona nueva o cambiada sí pasa por la
 * lista.
 */
export function validateTimeZone(
  raw: string | null | undefined,
  stored?: string | null,
): string | RegionalError {
  if (blank(raw)) {
    return { field: 'timeZone', message: REGIONAL_MESSAGES.timeZoneMissing };
  }
  const timeZone = canonicalTimeZoneName(raw);
  if (timeZone) return timeZone;
  if (isStoredTimeZone(raw, stored)) return stored;
  return {
    field: 'timeZone',
    message: REGIONAL_MESSAGES.timeZoneUnknown(raw.trim()),
  };
}

/** `raw` es la zona `stored` de la sede, sin distinguir mayúsculas. */
export function isStoredTimeZone(
  raw: string,
  stored: string | null | undefined,
): stored is string {
  return (
    typeof stored === 'string' &&
    raw.trim().toLowerCase() === stored.toLowerCase()
  );
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

/** G1-B (spec §4.1): `'h12'` o `'h23'`, sin otra forma ni valor por defecto. */
export function validateHourCycle(
  raw: string | null | undefined,
): HourCycle | RegionalError {
  if (blank(raw)) {
    return { field: 'hourCycle', message: REGIONAL_MESSAGES.hourCycleMissing };
  }
  const hourCycle = raw.trim();
  if (!isHourCycle(hourCycle)) {
    return {
      field: 'hourCycle',
      message: REGIONAL_MESSAGES.hourCycleInvalid(hourCycle),
    };
  }
  return hourCycle;
}

/**
 * Valida los campos en el orden moneda, zona, formato y reloj, y devuelve los
 * valores canónicos (moneda en mayúsculas, locale canonicalizado) o el primer
 * error. La existencia de la moneda se consulta por el puerto
 * `CURRENCY_WHITELIST`.
 *
 * G1-B fase 1 (spec §4.1, §4.3): sin reloj (ausente o null) es la forma de la
 * web de G1, que trae los otros tres: se acepta con `hourCycle: null` y nunca
 * se inventa un valor aquí. Fase 2: obligatorio.
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
  if (input.hourCycle === undefined || input.hourCycle === null) {
    return { currency, timeZone, locale, hourCycle: null };
  }
  const hourCycle = validateHourCycle(input.hourCycle);
  if (typeof hourCycle !== 'string') return hourCycle;
  return { currency, timeZone, locale, hourCycle };
}

/**
 * DX-329 (R3): la región cuyo prefijo toma un teléfono escrito sin «+». `null`
 * o vacío es «sin prefijo por defecto». Si no, dos letras, recortadas y en
 * mayúsculas, de la lista de la librería. `stored` es la región ya guardada de
 * la sede (PATCH): la misma, aunque la versión instalada ya no la admita, se
 * devuelve tal cual, como `validateTimeZone`. Nunca se deduce del país.
 */
export function validateDefaultPhoneRegion(
  raw: string | null | undefined,
  stored?: string | null,
): string | null | DefaultPhoneRegionError {
  if (blank(raw)) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return {
      field: 'defaultPhoneRegion',
      message: DEFAULT_PHONE_REGION_INVALID,
    };
  }
  if (isPhoneRegion(code)) return code;
  if (stored === code) return code;
  return {
    field: 'defaultPhoneRegion',
    message: DEFAULT_PHONE_REGION_UNKNOWN(code),
  };
}
