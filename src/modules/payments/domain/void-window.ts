/**
 * Día civil (YYYY-MM-DD) de un instante en una zona IANA. `en-CA` formatea
 * fechas como `2026-10-16`, así que el resultado se compara como texto.
 */
export function civilDateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * ¿Caen `a` y `b` en el MISMO día del calendario de la sede? Es la ventana en
 * la que recepción puede anular un abono suyo (SEC-013): el "hoy" de la caja
 * que se arquea en esa sede, no el día UTC del servidor.
 */
export function isSameCivilDay(a: Date, b: Date, timeZone: string): boolean {
  return civilDateIn(a, timeZone) === civilDateIn(b, timeZone);
}
