import {
  civilDateIn,
  isValidTimeZone,
  wallMillisOfDay,
} from '../time/civil-day';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * DX-053: instante ISO 8601 a segundos con el desfase de `zone`
 * (`2026-11-21T09:30:00-04:00`, cambio de hora incluido) o, sin zona o con
 * una inválida, en UTC (`…Z`). Formato de intercambio (CSV de la
 * exportación), no texto para leer: no depende del idioma de la sede.
 * `isoUtc` es `AAAA-MM-DDTHH:MM:SS(.mmm)Z`.
 */
export function zonedIsoInstant(isoUtc: string, zone: string | null): string {
  const utc = `${isoUtc.slice(0, 19)}Z`;
  if (!zone || !isValidTimeZone(zone)) return utc;
  const instant = new Date(isoUtc);
  const day = civilDateIn(instant, zone);
  const wall = wallMillisOfDay(instant, zone);
  const [y, m, d] = day.split('-').map(Number);
  // Desfase = hora de pared − UTC, en minutos enteros.
  const offsetMin = Math.round(
    (Date.UTC(y, m - 1, d) + wall - instant.getTime()) / 60_000,
  );
  const seconds = Math.floor(wall / 1000);
  const time = [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map(pad)
    .join(':');
  const abs = Math.abs(offsetMin);
  const offset = `${offsetMin < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${day}T${time}${offset}`;
}
