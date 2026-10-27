import { ConflictException } from '@nestjs/common';
import type {
  AffectingBlocksQuery,
  ScheduleBlockRepository,
} from '../../schedule-blocks/domain/ports/schedule-block-repository.port';
import {
  blockConflictMessage,
  blockWarningMessage,
} from '../../schedule-blocks/domain/schedule-block-rules';
import { requireLocationFormat } from '../../../shared/locations/location-regional';

/**
 * Bloqueos que tocan una cita (DX-122), al agendarla o moverla: si alguno NO
 * deja agendar encima, 409 con el motivo y el rango en la hora de la sede; si
 * solo hay bloqueos que lo permiten (almuerzo), devuelve sus avisos. Hora y
 * día en el formato y el reloj de la sede (G1-B), pedidos solo si hay algún
 * bloqueo que pintar: sin ellos, 409 `LOCATION_LOCALE_REQUIRED` (I4).
 */
export async function checkScheduleBlocks(
  blocks: ScheduleBlockRepository,
  query: AffectingBlocksQuery,
): Promise<string[]> {
  const found = await blocks.findAffecting(query);
  const { blocks: affecting, timeZone } = found;
  if (affecting.length === 0) return [];
  const fmt = requireLocationFormat({
    id: found.locationId,
    locale: found.locale,
    hourCycle: found.hourCycle,
  });
  const blocking = affecting.find((b) => !b.allowsBooking);
  if (blocking) {
    throw new ConflictException(blockConflictMessage(blocking, timeZone, fmt));
  }
  return affecting.map((b) => blockWarningMessage(b, timeZone, fmt));
}
