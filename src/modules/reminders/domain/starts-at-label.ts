import type { ClinicCountry } from '@prisma/client';

/**
 * Fecha y hora de la cita para el email, en la zona IANA de la sede y en
 * español: «martes 20 de octubre de 2026 a las 9:30 a. m.». Las sedes de
 * España leen la hora en 24 h («a las 16:30»), como se escribe allí. Se arma
 * con las partes de Intl para no depender de los separadores de cada versión
 * de ICU (algunas meten espacios duros).
 */
export function startsAtLabel(
  start: Date,
  timeZone: string,
  country: ClinicCountry,
): string {
  const hour12 = country !== 'ES';
  const parts = new Intl.DateTimeFormat(hour12 ? 'es-CO' : 'es-ES', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: hour12 ? 'h12' : 'h23',
  }).formatToParts(start);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const date = `${part('weekday')} ${part('day')} de ${part('month')} de ${part('year')}`;
  const time = `${Number(part('hour'))}:${part('minute')}`;
  const period = hour12 ? ` ${part('dayPeriod').replace(/\s+/g, ' ')}` : '';
  return `${date} a las ${time}${period}`;
}
