import { ImportFileError } from '../../patient-imports/domain/tabular-file';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
  addCivilDays,
  civilDaysInclusive,
  parseCivilDate,
} from '../../../shared/time/civil-day';
import type {
  HolidayCandidate,
  HolidayRowError,
  ParsedHolidayFile,
} from './holiday-file';
import {
  HOLIDAY_MESSAGES,
  HolidayRuleError,
  MAX_HOLIDAYS_PER_FILE,
  assertRecurringAllowed,
  validateHolidayDate,
  validateHolidayName,
} from './holiday-rules';

/**
 * Lector ICS de festivos (spec §5.3), puro: un subconjunto estricto de
 * RFC 5545 sin dependencias. Solo eventos de día completo de primer nivel; lo
 * que no se sabe leer (horas, repeticiones que no son «cada año el mismo día»,
 * duraciones raras) es un error de fila, nunca una lectura aproximada: un
 * `DATE-TIME` no se lleva a ninguna zona.
 */

const MAX_EVENT_DAYS = 31;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Una línea lógica (ya desplegada) y la línea física donde empieza. */
interface ContentLine {
  line: number;
  name: string;
  /** Nombre del parámetro en mayúsculas → sus valores, sin comillas. */
  params: Map<string, string>;
  value: string;
  /**
   * Tenía nombre pero no se pudo leer (sin `:`, comillas sin cerrar): `value`
   * es lo que sigue al nombre. Nunca se descarta en silencio.
   */
  malformed?: true;
}

interface RawEvent {
  line: number;
  props: ContentLine[];
}

type Entry = HolidayCandidate | HolidayRowError;

export function parseIcsHolidays(bytes: Buffer): ParsedHolidayFile {
  const candidates: HolidayCandidate[] = [];
  const errors: HolidayRowError[] = [];
  for (const event of topLevelEvents(logicalLines(bytes))) {
    for (const entry of readEvent(event)) {
      // La entrada 501 corta la lectura: ni se expande ni se sigue leyendo.
      if (candidates.length + errors.length === MAX_HOLIDAYS_PER_FILE) {
        throw new ImportFileError(HOLIDAY_MESSAGES.tooManyEntries);
      }
      if ('message' in entry) errors.push(entry);
      else candidates.push(entry);
    }
  }
  return { format: 'ICS', candidates, errors };
}

const SP = 0x20;
const HTAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;

/** Una línea ya desplegada y decodificada, con la línea física donde empieza. */
interface LogicalLine {
  line: number;
  text: string;
}

/**
 * Líneas lógicas. Se despliegan sobre los BYTES y luego se decodifican
 * (RFC 5545 §3.1): un plegado puede partir en dos un carácter UTF-8 de varios
 * bytes. Saltos CRLF, LF o CR; una línea que empieza por espacio o tabulador
 * continúa la anterior (sin ese primer blanco). Las vacías se saltan. Antes
 * de `BEGIN:VCALENDAR` se saltan el BOM y los blancos, pero sus saltos de
 * línea cuentan para `line`. Se decodifica todo antes de leer: un byte que no
 * es UTF-8 es error del fichero aunque esté tras la entrada 501.
 */
function logicalLines(bytes: Buffer): LogicalLine[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: LogicalLine[] = [];
  let parts: Buffer[] = [];
  let partsLine = 0;
  const flush = () => {
    if (parts.length === 0) return;
    let text: string;
    try {
      text = decoder.decode(Buffer.concat(parts));
    } catch {
      throw new ImportFileError(HOLIDAY_MESSAGES.icsNotUtf8);
    }
    lines.push({ line: partsLine, text });
    parts = [];
  };

  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let at = bom ? 3 : 0;
  let content = false;
  for (let line = 1; ; line++) {
    let end = at;
    while (end < bytes.length && bytes[end] !== CR && bytes[end] !== LF) end++;
    let raw = bytes.subarray(at, end);
    if (parts.length > 0 && (raw[0] === SP || raw[0] === HTAB)) {
      parts.push(raw.subarray(1));
    } else {
      flush();
      if (!content) {
        const first = raw.findIndex((b) => b !== SP && b !== HTAB);
        raw = first === -1 ? raw.subarray(raw.length) : raw.subarray(first);
        content = raw.length > 0;
      }
      if (raw.length > 0) {
        parts = [raw];
        partsLine = line;
      }
    }
    if (end === bytes.length) break;
    at = bytes[end] === CR && bytes[end + 1] === LF ? end + 2 : end + 1;
  }
  flush();
  return lines;
}

const NAME = /[A-Za-z0-9-]+/y;
const PARAM_NAME = /;([A-Za-z0-9-]+)=/y;
const QUOTED = /"([^"]*)"/y;
const UNQUOTED = /[^";:,]*/y;

/** `re` (pegajosa) en `at`, o `null`. Sin `slice`: lineal en la línea. */
function stick(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/**
 * `NOMBRE;PARAM=valor;PARAM="va:l;or":VALOR`. Los valores entre comillas
 * pueden llevar `:` `;` `,`. Sin nombre, `null`; con nombre pero mal formada
 * (sin `:`, comillas sin cerrar), `malformed`.
 */
function parseContentLine(line: number, text: string): ContentLine | null {
  const head = stick(NAME, text, 0);
  if (!head) return null;
  const name = head[0].toUpperCase();
  const malformed = (): ContentLine => ({
    line,
    name,
    params: new Map(),
    value: text.slice(head[0].length),
    malformed: true,
  });
  const params = new Map<string, string>();
  let at = head[0].length;
  for (let param; (param = stick(PARAM_NAME, text, at));) {
    at += param[0].length;
    const values: string[] = [];
    for (;;) {
      const value = stick(QUOTED, text, at) ?? stick(UNQUOTED, text, at);
      if (!value) return malformed();
      values.push(value[1] ?? value[0]);
      at += value[0].length;
      if (text[at] !== ',') break;
      at += 1;
    }
    const key = param[1].toUpperCase();
    if (!params.has(key)) params.set(key, values.join(','));
  }
  if (text[at] !== ':') return malformed();
  return {
    line,
    name,
    params,
    value: text.slice(at + 1),
  };
}

/**
 * Los `VEVENT` sin más componente alrededor que `VCALENDAR`, cada uno al leer
 * su `END:VEVENT`: así el tope de 500 corta sin leer el resto del fichero.
 * Las propiedades de los componentes anidados (`VALARM`) no son del evento.
 */
function* topLevelEvents(lines: LogicalLine[]): Generator<RawEvent> {
  if (lines.length === 0) throw new ImportFileError(HOLIDAY_MESSAGES.emptyFile);
  const stack: string[] = [];
  /** Componentes abiertos que no son `VCALENDAR`. */
  let nested = 0;
  let event: RawEvent | null = null;
  /** Profundidad de la pila dentro del evento abierto (su `VEVENT` incluido). */
  let eventDepth = 0;
  let events = 0;
  let first = true;
  for (const { line, text } of lines) {
    const content = parseContentLine(line, text);
    if (first) {
      first = false;
      if (
        content?.name !== 'BEGIN' ||
        content.malformed ||
        component(content) !== 'VCALENDAR'
      ) {
        throw new ImportFileError(HOLIDAY_MESSAGES.extensionMismatch('ics'));
      }
    }
    if (content === null) continue;
    if (
      (content.name === 'BEGIN' || content.name === 'END') &&
      content.malformed
    ) {
      throw new ImportFileError(HOLIDAY_MESSAGES.icsIncomplete);
    }
    if (content.name === 'BEGIN') {
      const name = component(content);
      if (name === 'VEVENT' && nested === 0) {
        event = { line: content.line, props: [] };
        eventDepth = stack.length + 1;
        events += 1;
      }
      stack.push(name);
      if (name !== 'VCALENDAR') nested += 1;
    } else if (content.name === 'END') {
      const name = stack.pop();
      if (name !== component(content)) {
        throw new ImportFileError(HOLIDAY_MESSAGES.icsIncomplete);
      }
      if (name !== 'VCALENDAR') nested -= 1;
      if (event && stack.length < eventDepth) {
        yield event;
        event = null;
      }
    } else if (event && stack.length === eventDepth) {
      event.props.push(content);
    }
  }
  if (stack.length > 0) {
    throw new ImportFileError(HOLIDAY_MESSAGES.icsIncomplete);
  }
  if (events === 0) throw new ImportFileError(HOLIDAY_MESSAGES.icsNoEvents);
}

function component(content: ContentLine): string {
  return content.value.trim().toUpperCase();
}

type DateRead = { date: string } | { error: string };

/**
 * Un `DATE` de 8 cifras. Con `T` o `VALUE` distinto de `DATE` es un
 * `DATE-TIME` (o un periodo): no es de día completo y no se desplaza. La
 * excepción es la forma de Exchange (`exchangeAllDay`, enmienda M1): una
 * medianoche local `T000000` (sin `Z`, con o sin `TZID`) es la fecha tal como
 * está escrita, sin pasar por ninguna zona.
 */
function readDate(prop: ContentLine, exchangeAllDay: boolean): DateRead {
  const raw = prop.value.trim();
  if (prop.malformed) return { error: HOLIDAY_MESSAGES.icsDateInvalid(raw) };
  const value = prop.params.get('VALUE')?.toUpperCase();
  const exchangeDate =
    exchangeAllDay && (value === undefined || value === 'DATE-TIME')
      ? /^(\d{8})T000000$/i.exec(raw)?.[1]
      : undefined;
  const dateTime = (value !== undefined && value !== 'DATE') || /t/i.test(raw);
  if (exchangeDate === undefined && dateTime) {
    return { error: HOLIDAY_MESSAGES.icsNotAllDay };
  }
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(exchangeDate ?? raw);
  const date = match && parseCivilDate(`${match[1]}-${match[2]}-${match[3]}`);
  return date ? { date } : { error: HOLIDAY_MESSAGES.icsDateInvalid(raw) };
}

/**
 * Días de `DTEND` (exclusivo) o `DURATION` (`P{n}D`, `P{n}W`); 1 sin ninguno.
 * Un `DTEND` igual a `DTSTART` es un día (enmienda M4): así escriben algunas
 * herramientas un evento de día completo sin duración.
 */
function eventDays(
  start: string,
  ends: ContentLine[],
  durations: ContentLine[],
  exchangeAllDay: boolean,
): number | { error: string } {
  if (ends.length + durations.length > 1) {
    return { error: HOLIDAY_MESSAGES.icsBadDuration };
  }
  if (ends.length === 1) {
    const end = readDate(ends[0], exchangeAllDay);
    if ('error' in end) return end;
    return end.date === start ? 1 : civilDaysInclusive(start, end.date) - 1;
  }
  if (durations.length === 1) {
    if (durations[0].malformed) {
      return { error: HOLIDAY_MESSAGES.icsBadDuration };
    }
    const raw = durations[0].value.trim().toUpperCase();
    const match = /^([+-]?)P(\d+)([DW])$/.exec(raw);
    if (match) {
      const days = Number(match[2]) * (match[3] === 'W' ? 7 : 1);
      return match[1] === '-' ? -days : days;
    }
    if (raw.includes('T')) return { error: HOLIDAY_MESSAGES.icsNotAllDay };
    return { error: HOLIDAY_MESSAGES.icsBadDuration };
  }
  return 1;
}

const WEEKDAYS = new Set(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);

/**
 * «Cada año el mismo día»: `FREQ=YEARLY` y, como mucho, `INTERVAL=1`, el mes y
 * el día de `DTSTART` y `WKST`. Cualquier otra parte, o una repetida, no.
 */
function isYearlyOnStart(rule: string, start: string): boolean {
  const seen = new Set<string>();
  const sameNumber = (value: string, expected: string) =>
    /^\d{1,2}$/.test(value) && Number(value) === Number(expected);
  for (const part of rule.split(';')) {
    if (part.trim() === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) return false;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part
      .slice(eq + 1)
      .trim()
      .toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    const ok =
      key === 'FREQ'
        ? value === 'YEARLY'
        : key === 'INTERVAL'
          ? /^0*1$/.test(value)
          : key === 'BYMONTH'
            ? sameNumber(value, start.slice(5, 7))
            : key === 'BYMONTHDAY'
              ? sameNumber(value, start.slice(8, 10))
              : key === 'WKST' && WEEKDAYS.has(value);
    if (!ok) return false;
  }
  return seen.has('FREQ');
}

/**
 * `\\` `\;` `\,` quitan el escape; `\n` y `\N` son un espacio. Los
 * controles que son blanco (TAB, VT, FF, NEL…) también son un espacio
 * (revisión M3): solo los demás controles hacen fallar el nombre.
 */
function unescapeText(value: string): string {
  return value
    .replace(/\\([\\;,nN])/g, (_, c: string) =>
      c === 'n' || c === 'N' ? ' ' : c,
    )
    .replace(/[\t-\r\u0085]+/g, ' ');
}

/**
 * Un día de un evento anual solo vale por su día y mes (enmienda I2): fuera
 * de 2000–2100 se guarda como su primera aparición en el rango, en 2000.
 * 2000 es bisiesto, así que todo 'MM-DD' existe (el 29 de febrero recurrente
 * lo rechaza luego R6).
 */
function intoRange(day: string): string {
  if (day >= PERIOD_DAY_MIN && day <= PERIOD_DAY_MAX) return day;
  // `slice(-5)` y no `monthDay`: pasado el 9999 la suma da '10000-01-01'.
  return `${PERIOD_DAY_MIN.slice(0, 4)}-${day.slice(-5)}`;
}

/**
 * Un evento: un error de fila, o un candidato por día. Orden de comprobación:
 * cancelado, `DTSTART`, duración, repetición, nombre; y por día, rango y 29 de
 * febrero recurrente (solo ese día falla). Perezoso: se expande día a día.
 */
function* readEvent(event: RawEvent): Generator<Entry> {
  const all = (name: string) => event.props.filter((p) => p.name === name);
  const { line } = event;

  const summaries = all('SUMMARY');
  let name: string | null = null;
  if (summaries.length === 1 && !summaries[0].malformed) {
    try {
      name = validateHolidayName(unescapeText(summaries[0].value));
    } catch (error) {
      if (!(error instanceof HolidayRuleError)) throw error;
    }
  }

  const exchangeAllDay = all('X-MICROSOFT-CDO-ALLDAYEVENT').some(
    (p) => !p.malformed && p.value.trim().toUpperCase() === 'TRUE',
  );
  const starts = all('DTSTART');
  const startRead: DateRead =
    starts.length === 0 || starts[0].value.trim() === ''
      ? { error: HOLIDAY_MESSAGES.nullField('DTSTART') }
      : starts.length > 1
        ? {
            error: HOLIDAY_MESSAGES.icsDateInvalid(
              starts.map((s) => s.value.trim()).join(', '),
            ),
          }
        : readDate(starts[0], exchangeAllDay);
  const start = 'date' in startRead ? startRead.date : null;

  const rules = all('RRULE');
  const otherRepeats = ['RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID'].some(
    (p) => all(p).length > 0,
  );
  const repeats = rules.length > 0 || otherRepeats;
  const supportedRepeat =
    !otherRepeats &&
    rules.length === 1 &&
    !rules[0].malformed &&
    start !== null &&
    isYearlyOnStart(rules[0].value, start);
  const recurring = !repeats ? false : supportedRepeat ? true : null;

  const fail = (message: string, date = start): HolidayRowError => ({
    line,
    date,
    name,
    recurring,
    message,
  });

  // Solo CANCELLED cambia algo: un STATUS ilegible que lo nombra, también.
  const cancelled = all('STATUS').some((s) =>
    s.malformed
      ? s.value.toUpperCase().includes('CANCELLED')
      : s.value.trim().toUpperCase() === 'CANCELLED',
  );
  const days =
    start === null
      ? 0
      : eventDays(start, all('DTEND'), all('DURATION'), exchangeAllDay);
  const problem = cancelled
    ? HOLIDAY_MESSAGES.icsCancelled
    : 'error' in startRead
      ? startRead.error
      : typeof days !== 'number'
        ? days.error
        : days < 1 || days > MAX_EVENT_DAYS
          ? HOLIDAY_MESSAGES.icsBadDuration
          : repeats && !supportedRepeat
            ? HOLIDAY_MESSAGES.icsUnsupportedRepeat
            : name === null
              ? HOLIDAY_MESSAGES.nameInvalid
              : null;
  if (problem !== null) {
    yield fail(problem);
    return;
  }
  if (start === null || name === null || typeof days !== 'number') {
    throw new Error('unreachable: a value without an error');
  }

  for (let i = 0; i < days; i++) {
    const written = i === 0 ? start : addCivilDays(start, i);
    // Pasado el 9999-12-31 el año tiene 5 cifras: un puntual ahí está fuera
    // de rango y se informa con la fecha del evento, nunca con una mal formada.
    if (recurring !== true && !CIVIL_DATE.test(written)) {
      yield fail(HOLIDAY_MESSAGES.dateOutOfRange, start);
      continue;
    }
    const day = recurring === true ? intoRange(written) : written;
    try {
      validateHolidayDate(day);
      assertRecurringAllowed(day, recurring === true);
    } catch (error) {
      if (!(error instanceof HolidayRuleError)) throw error;
      yield fail(error.message, day);
      continue;
    }
    yield { line, date: day, name, recurring: recurring === true };
  }
}
