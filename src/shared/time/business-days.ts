import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
  isValidTimeZone,
  parseCivilDate,
} from './civil-day';

/**
 * Días hábiles de una sede (DX-316), sobre días CIVILES: se avanza día a día
 * con `addCivilDays` y nunca sumando milisegundos, así un día de 23 o 25 horas
 * (cambio de hora) cuenta como un día. Puro: sin BD ni `Date.now()`.
 */

export interface BusinessCalendar {
  /** 0 = domingo … 6 = sábado (civilWeekday). Al menos uno. */
  readonly workingWeekdays: readonly number[];
  /** `date` 'YYYY-MM-DD'. recurring: cada año ese mes y día (R6). */
  readonly holidays: readonly {
    readonly date: string;
    readonly recurring: boolean;
  }[];
}

/** Tope de `n`: unos 14 años de días hábiles. */
const MAX_BUSINESS_DAYS = 3660;
/** Días seguidos sin ningún día hábil a partir de los cuales el calendario no tiene días hábiles de hecho. */
const MAX_NON_BUSINESS_STREAK = 366;

interface CompiledCalendar {
  weekdays: ReadonlySet<number>;
  oneOff: ReadonlySet<string>;
  /** 'MM-DD' */
  recurring: ReadonlySet<string>;
}

function compile(calendar: BusinessCalendar): CompiledCalendar {
  const { workingWeekdays, holidays } = calendar;
  if (workingWeekdays.length === 0) {
    throw new RangeError('workingWeekdays needs at least one day');
  }
  for (const weekday of workingWeekdays) {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new RangeError(`Invalid working weekday: ${weekday}`);
    }
  }
  const oneOff = new Set<string>();
  const recurring = new Set<string>();
  for (const holiday of holidays) {
    if (parseCivilDate(holiday.date) === null) {
      throw new RangeError(`Invalid holiday date: ${holiday.date}`);
    }
    if (!holiday.recurring) {
      oneOff.add(holiday.date);
      continue;
    }
    const monthDay = holiday.date.slice(5);
    // R6: la BD nunca guarda un recurrente del 29 de febrero.
    if (monthDay === '02-29') {
      throw new RangeError('A recurring holiday cannot be on 29 February');
    }
    recurring.add(monthDay);
  }
  return { weekdays: new Set(workingWeekdays), oneOff, recurring };
}

function isBusiness(day: string, calendar: CompiledCalendar): boolean {
  return (
    calendar.weekdays.has(civilWeekday(day)) &&
    !calendar.oneOff.has(day) &&
    !calendar.recurring.has(day.slice(5))
  );
}

function requireDay(day: string): string {
  if (parseCivilDate(day) === null) {
    throw new RangeError(`Invalid civil date: ${day}`);
  }
  return day;
}

/** ¿`day` ('YYYY-MM-DD') es hábil? Día de la semana hábil y no festivo. */
export function isBusinessDay(
  day: string,
  calendar: BusinessCalendar,
): boolean {
  return isBusiness(requireDay(day), compile(calendar));
}

/**
 * El n-ésimo día hábil DESPUÉS del día de inicio, como día civil 'YYYY-MM-DD'.
 * - `date`: un instante (se pasa a día civil en `timeZone`) o un día civil
 *   'YYYY-MM-DD' (se usa tal cual; `timeZone` se valida igual).
 * - El día de inicio nunca cuenta. n = 0 devuelve el día de inicio, sea o no hábil.
 * - RangeError si n no es un entero de 0 a 3660, si la zona, el día o el
 *   calendario no son válidos, o si hay 366 días seguidos sin ningún día hábil.
 * - El fin del plazo como instante lo saca quien llama con `civilDayRange`.
 */
export function addBusinessDays(
  date: Date | string,
  n: number,
  calendar: BusinessCalendar,
  timeZone: string,
): string {
  if (!Number.isInteger(n) || n < 0 || n > MAX_BUSINESS_DAYS) {
    throw new RangeError(`n must be an integer from 0 to ${MAX_BUSINESS_DAYS}`);
  }
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Invalid time zone: ${timeZone}`);
  }
  let day: string;
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
    // Mismas reglas que un día civil de texto: años 0100–9999.
    day = requireDay(civilDateIn(date, timeZone));
  } else {
    day = requireDay(date);
  }
  const compiled = compile(calendar);

  let counted = 0;
  let streak = 0;
  while (counted < n) {
    day = addCivilDays(day, 1);
    if (isBusiness(day, compiled)) {
      counted += 1;
      streak = 0;
    } else if (++streak >= MAX_NON_BUSINESS_STREAK) {
      throw new RangeError(
        `No business day in ${MAX_NON_BUSINESS_STREAK} consecutive days`,
      );
    }
  }
  return day;
}
