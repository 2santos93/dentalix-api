import { ISO_ZERO_DECIMAL_CURRENCIES } from '../money/currency-decimals';

/**
 * Helper único de formato regional (DX-350). Mismo contrato que la web y los
 * mismos vectores dorados (`regional-format.cases.json`).
 *
 * Qué decide cada ajuste de la sede:
 * - `locale`: separadores de número, orden de la fecha y símbolo de moneda.
 * - `hourCycle`: 12 h o 24 h; siempre se pasa explícito a `Intl`, así que ni
 *   el dato del locale ni una extensión `-u-hc-` cambian el reloj.
 * - Nunca las palabras: meses, días y «a. m./p. m.» salen de `UI_LANGUAGE`.
 * - Nunca el calendario ni los dígitos: siempre gregoriano y latinos, aunque
 *   el locale traiga `-u-ca-` o `-u-nu-`.
 *
 * Sin valores por defecto: quien formatea pasa los ajustes de la sede.
 */

/** Idioma del producto (todas las palabras), no un valor de reserva regional. */
export const UI_LANGUAGE = 'es';

export type HourCycle = 'h12' | 'h23';

export interface RegionalSettingsForFormat {
  locale: string;
  hourCycle: HourCycle;
}

/** Hora de pared en una zona, para lógica; nunca para pintar. Hora 0–23. */
export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface RegionalFormat {
  readonly locale: string;
  readonly hourCycle: HourCycle;
  /** Por defecto min 0 y max = max(2, min) decimales (nunca max < min). */
  number(value: number, digits?: { min?: number; max?: number }): string;
  /** 12.5 → «12.5%» / «12,5 %». Por defecto max 2 decimales. */
  percent(value: number, maxDigits?: number): string;
  /** 0 decimales si la moneda no tiene unidad menor y el importe es entero; si no, 2. */
  money(amount: number, currency: string): string;
  /** Día, mes (2 cifras) y año (4) en el orden del locale. */
  date(instant: Date, timeZone: string): string;
  /** 'YYYY-MM-DD' sin zona, mismo formato que `date()`. */
  civilDate(day: string): string;
  dayMonth(instant: Date, timeZone: string): string;
  time(instant: Date, timeZone: string): string;
  dateTime(instant: Date, timeZone: string): string;
  /** «martes 20 de octubre de 2026», sin coma. */
  longDate(
    instant: Date,
    timeZone: string,
    opts?: { weekday?: boolean },
  ): string;
  /** «martes 20 de octubre de 2026 a las 3:05 p. m.» */
  longDateTime(instant: Date, timeZone: string): string;
  /** Hora de reloj sin instante (0–23, 0–59); misma composición que `time()`. */
  clock(hour: number, minute: number): string;
  wallParts(instant: Date, timeZone: string): WallParts;
}

const HOUR_CYCLES: readonly string[] = ['h12', 'h23'];
const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BIDI_MARKS_RE = /[\u200e\u200f\u061c]/g;
const SPACES_RE = /\s+/g;

/** Calendario y dígitos fijos para cualquier locale, también con `-u-ca-`/`-u-nu-`. */
const DATE_BASE = { calendar: 'gregory', numberingSystem: 'latn' } as const;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();
const regionalFormats = new Map<string, RegionalFormat>();

function dateFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...DATE_BASE, ...options });
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

function numberFormatter(
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      ...options,
      numberingSystem: 'latn',
    });
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

function stripBidi(text: string): string {
  return text.replace(BIDI_MARKS_RE, '');
}

function partsOf(
  formatter: Intl.DateTimeFormat,
  instant: Date,
): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

/** Hora de pared con un formatter neutro fijo: es lógica, no presentación. */
function wallParts(instant: Date, timeZone: string): WallParts {
  const parts = partsOf(
    dateFormatter('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
    instant,
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** `HH:mm` en h23; `H:mm <dayPeriod>` en h12 con el periodo de `UI_LANGUAGE`. Separador siempre `:`. */
function clock(hourCycle: HourCycle, hour: number, minute: number): string {
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError(`Hora de reloj fuera de rango: ${hour}:${minute}`);
  }
  const mm = String(minute).padStart(2, '0');
  if (hourCycle === 'h23') return `${String(hour).padStart(2, '0')}:${mm}`;
  const parts = partsOf(
    dateFormatter(UI_LANGUAGE, {
      timeZone: 'UTC',
      hourCycle: 'h12',
      hour: 'numeric',
      minute: '2-digit',
    }),
    new Date(Date.UTC(2000, 0, 1, hour, minute)),
  );
  const dayPeriod = (parts.dayPeriod ?? '').replace(SPACES_RE, ' ').trim();
  return `${parts.hour}:${mm} ${dayPeriod}`;
}

/** Valida los ajustes y devuelve el locale canónico (`en-us` → `en-US`). */
function assertSettings(
  settings: RegionalSettingsForFormat | undefined,
): string {
  const locale: unknown = settings?.locale;
  const hourCycle: unknown = settings?.hourCycle;
  if (typeof hourCycle !== 'string' || !HOUR_CYCLES.includes(hourCycle)) {
    throw new RangeError(`Reloj no válido: ${String(hourCycle)}`);
  }
  if (typeof locale !== 'string' || locale === '') {
    throw new RangeError(`Locale no válido: ${String(locale)}`);
  }
  // `getCanonicalLocales` lanza RangeError si no es BCP 47.
  const [canonical] = Intl.getCanonicalLocales(locale);
  if (Intl.DateTimeFormat.supportedLocalesOf(canonical).length === 0) {
    throw new RangeError(`Locale no soportado: ${locale}`);
  }
  return canonical;
}

function build(locale: string, hourCycle: HourCycle): RegionalFormat {
  const number = (
    value: number,
    digits: { min?: number; max?: number } = {},
  ): string => {
    const min = digits.min ?? 0;
    const max = digits.max ?? Math.max(2, min);
    return stripBidi(
      numberFormatter(locale, {
        minimumFractionDigits: min,
        maximumFractionDigits: max,
      }).format(value),
    );
  };

  const date = (instant: Date, timeZone: string): string =>
    stripBidi(
      dateFormatter(locale, {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(instant),
    );

  const time = (instant: Date, timeZone: string): string => {
    const wall = wallParts(instant, timeZone);
    return clock(hourCycle, wall.hour, wall.minute);
  };

  const longDate = (
    instant: Date,
    timeZone: string,
    opts: { weekday?: boolean } = {},
  ): string => {
    const parts = partsOf(
      dateFormatter(UI_LANGUAGE, {
        timeZone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
      instant,
    );
    const dayMonthYear = `${parts.day} de ${parts.month} de ${parts.year}`;
    return opts.weekday === false
      ? dayMonthYear
      : `${parts.weekday} ${dayMonthYear}`;
  };

  return {
    locale,
    hourCycle,
    number,
    percent: (value, maxDigits = 2) =>
      stripBidi(
        numberFormatter(locale, {
          style: 'percent',
          maximumFractionDigits: maxDigits,
        }).format(value / 100),
      ),
    money: (amount, currency) => {
      const digits =
        ISO_ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) &&
        Number.isInteger(amount)
          ? 0
          : 2;
      try {
        return stripBidi(
          numberFormatter(locale, {
            style: 'currency',
            currency,
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(amount),
        );
      } catch (error) {
        // Intl acepta cualquier código bien formado; solo uno mal formado cae aquí.
        if (!(error instanceof RangeError)) throw error;
        return `${currency} ${number(amount, { min: digits, max: digits })}`;
      }
    },
    date,
    civilDate: (day) => {
      const match = CIVIL_DATE_RE.exec(day);
      const instant = match
        ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]))
        : undefined;
      if (!instant || instant.toISOString().slice(0, 10) !== day) {
        throw new RangeError(`Día civil no válido: ${day}`);
      }
      return date(instant, 'UTC');
    },
    dayMonth: (instant, timeZone) =>
      stripBidi(
        dateFormatter(locale, {
          timeZone,
          month: '2-digit',
          day: '2-digit',
        }).format(instant),
      ),
    time,
    dateTime: (instant, timeZone) =>
      `${date(instant, timeZone)} ${time(instant, timeZone)}`,
    longDate,
    longDateTime: (instant, timeZone) =>
      `${longDate(instant, timeZone)} a las ${time(instant, timeZone)}`,
    clock: (hour, minute) => clock(hourCycle, hour, minute),
    wallParts,
  };
}

/**
 * Formato con los ajustes de la sede. Lanza RangeError si el locale no es un
 * BCP 47 soportado o el reloj no es h12/h23. Cachea por (locale canónico,
 * hourCycle): `en-us` y `en-US` comparten entrada, y `locale` sale canónico.
 */
export function regionalFormat(
  settings: RegionalSettingsForFormat,
): RegionalFormat {
  const locale = assertSettings(settings);
  const key = `${locale}|${settings.hourCycle}`;
  let format = regionalFormats.get(key);
  if (!format) {
    format = build(locale, settings.hourCycle);
    regionalFormats.set(key, format);
  }
  return format;
}
