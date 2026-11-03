import type { RegionalFormat } from '../../../shared/format/regional-format';

/** Un tramo de atención de un día, en minutos de pared desde 00:00. */
export interface ScheduleRange {
  weekday: number; // 0=domingo .. 6=sábado (Date.getDay())
  startMinute: number;
  endMinute: number;
}

/** Horario de una sede: su zona horaria + los tramos de la semana. */
export interface BusinessHours {
  timezone: string;
  ranges: ScheduleRange[];
}

/**
 * Traslada un INSTANTE a la hora de PARED de una zona.
 *
 * Por qué hace falta: `Appointment.start` es un instante (el front convierte la
 * hora local que eligió el usuario a UTC antes de enviarla), pero los tramos del
 * horario son hora de pared ("9:00"). Comparar sin trasladar daría un resultado
 * corrido por el offset — y como esto BLOQUEA, rechazaría citas legítimas.
 *
 * Truco estándar: se formatean las partes en la zona destino y se rearma un Date
 * con `Date.UTC`, de forma que los componentes UTC del resultado SON la hora de
 * pared. Así se puede usar `getUTCDay()`/`getUTCHours()` sin mapear nombres de
 * día (que dependerían del locale).
 */
function toWallClock(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23', // evita el "24" que devuelve hour12:false en algunos runtimes
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(
    Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    ),
  );
}

export interface WallClockSlot {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/**
 * La cita expresada en hora de pared de la sede. `endMinute` se calcula como
 * `startMinute + duración`, así que una cita que cruza medianoche da > 1440 y
 * por construcción no cabe en ningún tramo (que es el resultado correcto: no se
 * puede atender a caballo de dos días).
 */
export function toWallClockSlot(
  start: Date,
  end: Date,
  timezone: string,
): WallClockSlot {
  const wall = toWallClock(start, timezone);
  const startMinute = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return {
    weekday: wall.getUTCDay(),
    startMinute,
    endMinute: startMinute + durationMinutes,
  };
}

/**
 * ¿La cita cae dentro del horario de atención?
 *
 * Reglas:
 * - `hours === null` (sede sin horario configurado) ⇒ SIN restricción. Es la
 *   clave de compatibilidad: si bloqueara, las clínicas existentes dejarían de
 *   poder agendar de golpe al desplegar.
 * - Sin tramos para ese día ⇒ día cerrado ⇒ no cabe.
 * - La cita tiene que caber COMPLETA en UN tramo: no vale repartirla entre el
 *   tramo de la mañana y el de la tarde (habría atención en medio del cierre).
 * - Comparación medio-abierta `[start, end)` contra `[rs, re)`, consistente con
 *   cómo se decide el solape de citas: terminar justo al cierre es válido.
 */
export function fitsBusinessHours(
  start: Date,
  end: Date,
  hours: BusinessHours | null,
): boolean {
  if (hours === null || hours.ranges.length === 0) {
    return true;
  }
  const slot = toWallClockSlot(start, end, hours.timezone);
  return hours.ranges
    .filter((r) => r.weekday === slot.weekday)
    .some(
      (r) => slot.startMinute >= r.startMinute && slot.endMinute <= r.endMinute,
    );
}

/**
 * Hora de pared (minutos desde 00:00) con el reloj de la sede. El final de un
 * tramo que llega a medianoche (1440) se escribe «24:00» en 24 h y «12:00 a. m.»
 * en 12 h (DX-354). Sin ceros ni separadores a mano: sale de `fmt.clock`.
 */
export function minuteText(minute: number, fmt: RegionalFormat): string {
  if (minute === 1440)
    return fmt.hourCycle === 'h23' ? '24:00' : fmt.clock(0, 0);
  return fmt.clock(Math.floor(minute / 60), minute % 60);
}

/** "09:00–13:00, 15:00–19:00" — para decirle al usuario cuándo SÍ se atiende. */
export function describeDayRanges(
  weekday: number,
  hours: BusinessHours,
  fmt: RegionalFormat,
): string {
  const ranges = hours.ranges
    .filter((r) => r.weekday === weekday)
    .sort((a, b) => a.startMinute - b.startMinute)
    .map(
      (r) =>
        `${minuteText(r.startMinute, fmt)}–${minuteText(r.endMinute, fmt)}`,
    );
  return ranges.join(', ');
}

const WEEKDAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

/**
 * Mensaje que explica el rechazo. Dice el horario real del día cuando lo hay,
 * y "no atiende" cuando el día está cerrado — que es la diferencia que el
 * usuario necesita para corregir. `fmt` es PEREZOSO (DX-354): solo se pide si
 * el día abre y hay horas que escribir; un día cerrado no necesita el formato
 * de la sede.
 */
export function businessHoursErrorMessage(
  start: Date,
  end: Date,
  hours: BusinessHours,
  fmt: () => RegionalFormat,
): string {
  const slot = toWallClockSlot(start, end, hours.timezone);
  const dayName = WEEKDAY_NAMES[slot.weekday];
  const isClosed = !hours.ranges.some((r) => r.weekday === slot.weekday);
  if (isClosed) {
    // "los lunes" pero "los domingos": en español los días terminados en -s son
    // invariables en plural, y solo sábado y domingo lo añaden.
    const plural = dayName.endsWith('s') ? dayName : `${dayName}s`;
    return `La sede no atiende los ${plural}`;
  }
  const ranges = describeDayRanges(slot.weekday, hours, fmt());
  return `Fuera del horario de atención (${dayName}: ${ranges})`;
}
