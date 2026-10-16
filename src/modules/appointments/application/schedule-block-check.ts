import { ConflictException } from '@nestjs/common';
import type {
  AffectingBlocksQuery,
  ScheduleBlockRepository,
} from '../../schedule-blocks/domain/ports/schedule-block-repository.port';
import {
  blockConflictMessage,
  blockWarningMessage,
} from '../../schedule-blocks/domain/schedule-block-rules';

/**
 * Bloqueos que tocan una cita (DX-122), al agendarla o moverla: si alguno NO
 * deja agendar encima, 409 con el motivo y el rango en la hora de la sede; si
 * solo hay bloqueos que lo permiten (almuerzo), devuelve sus avisos.
 */
export async function checkScheduleBlocks(
  blocks: ScheduleBlockRepository,
  query: AffectingBlocksQuery,
): Promise<string[]> {
  const { blocks: affecting, timeZone } = await blocks.findAffecting(query);
  const blocking = affecting.find((b) => !b.allowsBooking);
  if (blocking) {
    throw new ConflictException(blockConflictMessage(blocking, timeZone));
  }
  return affecting.map((b) => blockWarningMessage(b, timeZone));
}
