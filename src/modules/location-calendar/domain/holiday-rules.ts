import type { RegionalFormat } from '../../../shared/format/regional-format';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
  parseCivilDate,
} from '../../../shared/time/civil-day';
import type { ParsedHolidayFile } from './holiday-file';

/**
 * Reglas del calendario de una sede (DX-316), puras: días hábiles, festivos y
 * la clasificación de un lote importado. Ninguna regla depende de un país.
 */

export const HOLIDAY_NAME_MAX = 120;
/** Entradas (candidatos o filas con error) por fichero importado (§5.1). */
export const MAX_HOLIDAYS_PER_FILE = 500;
/** Festivos vivos por sede (§5.1). */
export const MAX_HOLIDAYS_PER_LOCATION = 1000;

/**
 * Textos de la spec (§5 y §6). Los que llevan cifras son funciones que se
 * pintan con el formato de la sede (G1-B); los de fila no llevan cifras: las
 * líneas relacionadas van en `relatedLines`.
 */
export const HOLIDAY_MESSAGES = {
  // Días hábiles
  weekdaysEmpty: 'Elige al menos un día hábil.',
  weekdayOutOfRange: 'Los días hábiles van de 0 (domingo) a 6 (sábado).',
  // Un festivo (API y filas del fichero)
  dateNotIso: (raw: string) =>
    `Fecha «${raw}» no válida: usa AAAA-MM-DD, por ejemplo 2027-05-03.`,
  dateOutOfRange: 'La fecha tiene que estar entre 2000 y 2100.',
  nameInvalid: 'El nombre es obligatorio (hasta 120 caracteres).',
  recurringInvalid: 'En «recurrente» escribe sí o no.',
  recurringFeb29: 'Un festivo de cada año no puede ser el 29 de febrero.',
  nullField: (field: string) => `Indica un valor para «${field}».`,
  // Choques (R5)
  repeatedInFile: 'La fecha se repite en el archivo.',
  crossClassInFile:
    'Choca con otra fila del archivo: un festivo de cada año y uno puntual no pueden caer el mismo día y mes.',
  alreadyImported: (name: string) => `Ya existe: «${name}».`,
  sameKeyConflict: (name: string) => `Ya hay un festivo ese día: «${name}».`,
  oneOffOnRecurring: (name: string) =>
    `Ese día ya es festivo cada año: «${name}».`,
  recurringOnOneOff: (name: string) =>
    `Ya hay un festivo puntual ese día y mes: «${name}». Elimínalo antes de crear uno que se repita cada año.`,
  // Recursos
  holidayNotFound: 'No encontramos ese festivo.',
  locationNotFound: 'No encontramos esa sede.',
  // Mismo texto que el resto de rutas de sede (cancelación, recordatorios).
  invalidLocationId: 'El identificador de la sede no es válido.',
  invalidHolidayId: 'El identificador del festivo no es válido.',
  rolesDenied:
    'Solo un administrador de la clínica puede ver o cambiar el calendario de la sede.',
  locationLimit: (fmt: RegionalFormat) =>
    `La sede tendría más de ${fmt.number(MAX_HOLIDAYS_PER_LOCATION)} festivos. Borra los de años pasados e inténtalo de nuevo.`,
  // Fichero (§5.1)
  missingFile: 'Falta el archivo.',
  emptyFile: 'El archivo está vacío.',
  fileTooLarge: 'El archivo supera 256 KB.',
  wrongExtension: 'Sube un archivo .csv o .ics.',
  extensionMismatch: (ext: string) =>
    `El archivo .${ext} no tiene el formato que dice su extensión.`,
  tooManyEntries: (fmt: RegionalFormat) =>
    `El archivo tiene más de ${fmt.number(MAX_HOLIDAYS_PER_FILE)} filas o días de festivo: divídelo.`,
  // CSV (§5.2)
  csvHeader:
    'La primera fila tiene que tener las columnas «fecha» y «nombre» (y, si quieres, «recurrente»).',
  // ICS (§5.3)
  icsNotUtf8: 'El calendario no está en UTF-8.',
  icsNoEvents: 'El calendario no tiene eventos.',
  icsIncomplete: 'El calendario está incompleto: falta END:VEVENT.',
  icsNotAllDay: 'Solo se importan eventos de día completo.',
  icsDateInvalid: (raw: string) => `Fecha «${raw}» no válida.`,
  icsBadDuration: 'El evento dura más de 31 días o termina antes de empezar.',
  icsCancelled: 'Evento cancelado: no se importa.',
  icsUnsupportedRepeat: 'Repetición no admitida: solo «cada año el mismo día».',
} as const;

export type HolidayRuleField =
  'date' | 'name' | 'recurring' | 'workingWeekdays';

/** Un dato del calendario que no vale: 400 con `message` (o error de fila). */
export class HolidayRuleError extends Error {
  readonly field: HolidayRuleField;

  constructor(field: HolidayRuleField, message: string) {
    super(message);
    this.field = field;
    this.name = 'HolidayRuleError';
  }
}

/** Ordenados y sin repetidos; al menos uno, cada uno de 0 (domingo) a 6. */
export function normalizeWorkingWeekdays(input: unknown): number[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HolidayRuleError(
      'workingWeekdays',
      HOLIDAY_MESSAGES.weekdaysEmpty,
    );
  }
  for (const day of input as unknown[]) {
    if (
      typeof day !== 'number' ||
      !Number.isInteger(day) ||
      day < 0 ||
      day > 6
    ) {
      throw new HolidayRuleError(
        'workingWeekdays',
        HOLIDAY_MESSAGES.weekdayOutOfRange,
      );
    }
  }
  return [...new Set(input as number[])].sort((a, b) => a - b);
}

/** 'YYYY-MM-DD' que existe y cae entre 2000-01-01 y 2100-12-31 (R8). */
export function validateHolidayDate(raw: unknown): string {
  const text =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number'
        ? String(raw)
        : '';
  const date = typeof raw === 'string' ? parseCivilDate(text) : null;
  if (date === null) {
    throw new HolidayRuleError('date', HOLIDAY_MESSAGES.dateNotIso(text));
  }
  if (date < PERIOD_DAY_MIN || date > PERIOD_DAY_MAX) {
    throw new HolidayRuleError('date', HOLIDAY_MESSAGES.dateOutOfRange);
  }
  return date;
}

/**
 * Caracteres de control (C0, DEL, C1) y los separadores de línea y párrafo,
 * que la BD también rechaza (`[[:cntrl:]]` en `location_holidays_name_check`).
 */
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u;
/**
 * Incrustaciones, anulaciones y aislamientos bidireccionales: reordenan a la
 * vista el nombre en las listas y en los mensajes «Ya existe: «X».».
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/u;
/** Formato (ancho cero, BOM…) y blancos: lo que no se ve. */
const INVISIBLE = /[\p{Cf}\s]/gu;

/**
 * Recortado, 1–120 caracteres (contados como `char_length`, no en unidades
 * UTF-16), con algo visible, sin caracteres de control ni de control
 * bidireccional. Un nombre que empieza por `=` se guarda tal cual: es texto;
 * solo las exportaciones a CSV lo neutralizan (P15).
 */
export function validateHolidayName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (
    name.replace(INVISIBLE, '') === '' ||
    [...name].length > HOLIDAY_NAME_MAX ||
    CONTROL_CHARS.test(name) ||
    BIDI_CONTROLS.test(name)
  ) {
    throw new HolidayRuleError('name', HOLIDAY_MESSAGES.nameInvalid);
  }
  return name;
}

/** R6: un recurrente no puede ser el 29 de febrero. */
export function assertRecurringAllowed(date: string, recurring: boolean): void {
  if (recurring && monthDay(date) === '02-29') {
    throw new HolidayRuleError('recurring', HOLIDAY_MESSAGES.recurringFeb29);
  }
}

/** 'MM-DD' de un 'YYYY-MM-DD'. */
export function monthDay(date: string): string {
  return date.slice(5);
}

interface HolidayKeyInput {
  date: string;
  recurring: boolean;
}

/** Clave de «misma clase y misma clave» (R5, R7): `'D:2027-05-03'` / `'R:05-03'`. */
export function holidayKey(h: HolidayKeyInput): string {
  return h.recurring ? `R:${monthDay(h.date)}` : `D:${h.date}`;
}

export type HolidayConflict =
  'SAME' | 'ONE_OFF_ON_RECURRING' | 'RECURRING_ON_ONE_OFF';

/**
 * R5 en las dos direcciones: un recurrente ocupa su 'MM-DD' en todos los
 * años, así que choca con cualquier puntual de ese día y mes.
 */
export function conflictOf(
  candidate: HolidayKeyInput,
  other: HolidayKeyInput,
): HolidayConflict | null {
  if (holidayKey(candidate) === holidayKey(other)) return 'SAME';
  if (monthDay(candidate.date) !== monthDay(other.date)) return null;
  if (candidate.recurring === other.recurring) return null;
  return candidate.recurring ? 'RECURRING_ON_ONE_OFF' : 'ONE_OFF_ON_RECURRING';
}

export type HolidayRowStatus = 'NEW' | 'DUPLICATE' | 'ERROR';

export interface ClassifiedRow {
  line: number;
  date: string | null;
  name: string | null;
  recurring: boolean | null;
  status: HolidayRowStatus;
  message: string | null;
  /** Líneas del fichero con las que choca (§5.1), ordenadas; [] si ninguna. */
  relatedLines: number[];
}

export interface LiveHoliday {
  id: string;
  date: string;
  name: string;
  recurring: boolean;
}

/** Orden total de los festivos vivos: el «primero por fecha» del mensaje es estable. */
function byDateThenId(a: LiveHoliday, b: LiveHoliday): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Clasifica un lote como CONJUNTO (spec §5.1, R5, R7): el resultado no
 * depende del orden de las filas ni del de `existing`. Cada fila recibe un
 * estado, en este orden:
 * 1. error de lectura → ERROR con su mensaje;
 * 2. choque dentro del fichero (se agrupa por 'MM-DD' y se marcan TODAS las
 *    filas que chocan, con las líneas de las otras en `relatedLines`). Si una
 *    fila choca de las dos maneras, gana «se repite»;
 * 3. contra los vivos: misma clave → DUPLICATE (no se sobrescribe el nombre);
 *    clases cruzadas → ERROR;
 * 4. el resto → NEW.
 * Devuelve las filas ordenadas por línea.
 */
export function classifyHolidayBatch(
  file: ParsedHolidayFile,
  existing: readonly LiveHoliday[],
): ClassifiedRow[] {
  const rows: ClassifiedRow[] = file.errors.map((e) => ({
    line: e.line,
    date: e.date,
    name: e.name,
    recurring: e.recurring,
    status: 'ERROR',
    message: e.message,
    relatedLines: [],
  }));

  const groups = new Map<string, typeof file.candidates>();
  for (const candidate of file.candidates) {
    const key = monthDay(candidate.date);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const live = [...existing].sort(byDateThenId);

  for (const candidate of file.candidates) {
    const base = {
      line: candidate.line,
      date: candidate.date,
      name: candidate.name,
      recurring: candidate.recurring,
    };
    let repeated = false;
    const related = new Set<number>();
    for (const other of groups.get(monthDay(candidate.date)) ?? []) {
      if (other === candidate) continue;
      const conflict = conflictOf(candidate, other);
      if (conflict === null) continue;
      if (conflict === 'SAME') repeated = true;
      if (other.line !== candidate.line) related.add(other.line);
    }
    if (repeated || related.size > 0) {
      rows.push({
        ...base,
        status: 'ERROR',
        message: repeated
          ? HOLIDAY_MESSAGES.repeatedInFile
          : HOLIDAY_MESSAGES.crossClassInFile,
        relatedLines: [...related].sort((a, b) => a - b),
      });
      continue;
    }

    const same = live.find((h) => conflictOf(candidate, h) === 'SAME');
    const crossed = live.find((h) => conflictOf(candidate, h) !== null);
    if (same) {
      rows.push({
        ...base,
        status: 'DUPLICATE',
        message: HOLIDAY_MESSAGES.alreadyImported(same.name),
        relatedLines: [],
      });
    } else if (crossed) {
      rows.push({
        ...base,
        status: 'ERROR',
        message: candidate.recurring
          ? HOLIDAY_MESSAGES.recurringOnOneOff(crossed.name)
          : HOLIDAY_MESSAGES.oneOffOnRecurring(crossed.name),
        relatedLines: [],
      });
    } else {
      rows.push({ ...base, status: 'NEW', message: null, relatedLines: [] });
    }
  }

  return rows.sort(compareRows);
}

/**
 * Tope por sede (§5.1): solo cuentan las filas NEW. Un fichero que solo
 * repite lo que ya hay nunca choca con el tope, aunque la sede ya lo pase.
 */
export function exceedsLocationLimit(
  liveCount: number,
  rows: readonly ClassifiedRow[],
): boolean {
  const created = rows.filter((row) => row.status === 'NEW').length;
  return created > 0 && liveCount + created > MAX_HOLIDAYS_PER_LOCATION;
}

/**
 * Por línea y, a igual línea (los días de un mismo evento del ICS), por fecha:
 * un orden total que no depende del orden de entrada.
 */
function compareRows(a: ClassifiedRow, b: ClassifiedRow): number {
  if (a.line !== b.line) return a.line - b.line;
  const ad = a.date ?? '';
  const bd = b.date ?? '';
  if (ad !== bd) return ad < bd ? -1 : 1;
  if (a.status !== b.status) return a.status < b.status ? -1 : 1;
  return 0;
}
