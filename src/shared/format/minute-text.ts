import type { RegionalFormat } from './regional-format';

/**
 * Hora de pared (minutos desde 00:00) con el reloj de la sede. El final de un
 * tramo que llega al fin del día (1440) se escribe «24:00» en 24 h y
 * «medianoche» en 12 h: «12:00 a. m.» sería también el minuto 0 y el tramo
 * quedaría ambiguo (DX-354). Lo demás sale de `fmt.clock`.
 */
export function minuteText(minute: number, fmt: RegionalFormat): string {
  if (minute === 1440) return fmt.hourCycle === 'h23' ? '24:00' : 'medianoche';
  return fmt.clock(Math.floor(minute / 60), minute % 60);
}
