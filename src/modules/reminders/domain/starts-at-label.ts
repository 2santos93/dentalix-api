import type { RegionalFormat } from '../../../shared/format/regional-format';

/**
 * Fecha y hora de la cita para el email, en la zona IANA de la sede, con su
 * formato y su reloj (G1-B): «martes 20 de octubre de 2026 a las 3:05 p. m.»
 * en una sede de 12 h, «… a las 15:05» en una de 24 h. Las palabras son
 * siempre en español; el reloj es el ajuste de la sede, nunca su país. La
 * usan el envío real y la vista previa de Ajustes, así que salen iguales.
 */
export function startsAtLabel(
  start: Date,
  timeZone: string,
  fmt: RegionalFormat,
): string {
  return fmt.longDateTime(start, timeZone);
}
