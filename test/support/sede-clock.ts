import { addCivilDays, civilDateIn } from '../../src/shared/time/civil-day';
import {
  REGIONAL_BOGOTA_FIXTURE,
  type RegionalFixture,
} from './location-fixtures';

/**
 * DX-209 (TST-049): «hoy» FIJO de un e2e, en la zona de la sede del fixture
 * (REGIONAL_BOGOTA_FIXTURE, UTC−5 sin horario de verano).
 *
 * Antes cada spec calculaba `TODAY = civilDateIn(new Date(), zona)` al cargar
 * el módulo y pagaba a `Date.now() − 60 s` dentro del test: si la corrida
 * cruzaba la medianoche de la sede (05:00 UTC, la hora de los merges
 * nocturnos), el abono caía en «ayer» y el spec salía en rojo sin que nada
 * fallara. Ahora el día es el anterior al de la carga del módulo y el instante
 * es su mediodía en la sede: queda en el pasado para el reloj real de la API
 * (que no se toca) y lejos de cualquier medianoche, corra la suite a la hora
 * que corra y dure lo que dure. El spec inyecta `at` en el reloj del módulo
 * que decide «hoy» (`EXCHANGE_RATE_CLOCK`, …).
 */
export interface SedeDay {
  /** `YYYY-MM-DD` del día en la sede. */
  day: string;
  /** El mediodía de ese día en la sede. */
  at: Date;
  /** `at` menos `seconds` segundos (abonos «de hace un momento»). */
  before(seconds: number): Date;
}

export const SEDE_FIXTURE_ZONE = 'America/Bogota';
const SEDE_FIXTURE_OFFSET = '-05:00';

export function fixedSedeDay(daysAgo = 1, now = new Date()): SedeDay {
  const day = addCivilDays(civilDateIn(now, SEDE_FIXTURE_ZONE), -daysAgo);
  const at = new Date(`${day}T12:00:00${SEDE_FIXTURE_OFFSET}`);
  return {
    day,
    at,
    before: (seconds) => new Date(at.getTime() - seconds * 1000),
  };
}

/**
 * DX-449 (TST-053): «hoy» de una sede para los specs de agenda y reservas que
 * necesitan citas de hoy YA EMPEZADAS (la API decide «hoy» con su reloj real y
 * la zona de la sede, sin reloj inyectable). A las 00:56 de Bogotá solo caben
 * 56 minutos entre la medianoche y «ahora»: las citas «de hace un rato» caían
 * en ayer o se recortaban al mismo hueco, y la CI de los merges nocturnos
 * (04:40–06:00 UTC) salía en rojo.
 *
 * La sede del fixture usa Bogotá mientras queden al menos
 * `SEDE_TODAY_MARGIN_MINUTES` desde y hasta su medianoche; si no, una zona sin
 * horario de verano en la que ahora es cerca del mediodía. Así «hace N
 * minutos» y «dentro de N minutos» son de hoy en la sede para cualquier N
 * menor que el margen, corra la suite a la hora que corra.
 */
export const SEDE_TODAY_MARGIN_MINUTES = 180;

/**
 * Una zona por desfase entero de UTC−11 a UTC+12, todas sin horario de verano:
 * siempre hay una con la hora local a ≤ 30 min del mediodía.
 */
export const NOON_ZONE_CANDIDATES: readonly string[] = [
  'Pacific/Pago_Pago',
  'Pacific/Honolulu',
  'Pacific/Gambier',
  'Pacific/Pitcairn',
  'America/Phoenix',
  'America/Regina',
  SEDE_FIXTURE_ZONE,
  'America/La_Paz',
  'America/Sao_Paulo',
  'America/Noronha',
  'Atlantic/Cape_Verde',
  'Africa/Abidjan',
  'Africa/Lagos',
  'Africa/Maputo',
  'Africa/Nairobi',
  'Asia/Dubai',
  'Asia/Tashkent',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Brisbane',
  'Pacific/Guadalcanal',
  'Pacific/Tarawa',
];

/** Minutos transcurridos del día civil de `zone` en `now`. */
export function minutesIntoDay(now: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: 'hour' | 'minute') =>
    Number(parts.find((p) => p.type === type)!.value);
  return part('hour') * 60 + part('minute');
}

/** Minutos hasta la medianoche más cercana (antes o después) de `zone`. */
function minutesFromMidnight(now: Date, zone: string): number {
  const minutes = minutesIntoDay(now, zone);
  return Math.min(minutes, 24 * 60 - minutes);
}

/**
 * La zona de la sede de los specs con citas «de hoy»: Bogotá si está a más de
 * `SEDE_TODAY_MARGIN_MINUTES` de su medianoche; si no, la candidata cuya hora
 * local esté más cerca del mediodía.
 */
export function safeTodayZone(now = new Date()): string {
  if (minutesFromMidnight(now, SEDE_FIXTURE_ZONE) >= SEDE_TODAY_MARGIN_MINUTES)
    return SEDE_FIXTURE_ZONE;
  let best = SEDE_FIXTURE_ZONE;
  for (const zone of NOON_ZONE_CANDIDATES) {
    if (minutesFromMidnight(now, zone) > minutesFromMidnight(now, best))
      best = zone;
  }
  return best;
}

/** El fixture regional de Bogotá con la zona de `safeTodayZone(now)`. */
export function sedeTodayFixture(now = new Date()): RegionalFixture {
  return { ...REGIONAL_BOGOTA_FIXTURE, timeZone: safeTodayZone(now) };
}

/**
 * Los días civiles de `zone` que toca el intervalo [now − minutes, now], del
 * más antiguo al más reciente (uno o dos): para sembrar lo que un dato
 * «de hace `minutes` minutos» pueda necesitar en su día (p. ej. la tasa).
 */
export function civilDaysSince(
  minutes: number,
  zone: string,
  now = new Date(),
): string[] {
  const from = civilDateIn(new Date(now.getTime() - minutes * 60_000), zone);
  const to = civilDateIn(now, zone);
  return from === to ? [to] : [from, to];
}
