import { addCivilDays, civilDateIn } from '../../src/shared/time/civil-day';

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
