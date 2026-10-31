import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ClinicRole, ScheduleBlockKind } from '@prisma/client';
import type {
  AffectingBlocksQuery,
  ScheduleBlockRepository,
} from '../../schedule-blocks/domain/ports/schedule-block-repository.port';
import {
  blockConflictMessage,
  blockWarningMessage,
} from '../../schedule-blocks/domain/schedule-block-rules';
import {
  RESERVED_OVERRIDE_FORBIDDEN_MESSAGE,
  canOverrideReserved,
  evaluateReservedBlock,
  overrideReasonError,
  reservedConflictMessage,
} from '../../schedule-blocks/domain/reserved-slot';
import { requireLocationFormat } from '../../../shared/locations/location-regional';

/** DX-446: lo que decide si una cita cabe en un hueco reservado. */
export interface ReservedSlotContext {
  /** Tipo de la cita (`null` = sin tipo: nunca es un tipo permitido). */
  appointmentTypeId: string | null;
  /** Reloj del servidor (inyectado): «¿ya se liberó?». */
  now: Date;
  /** Rol de quien agenda o mueve (`null` = sin usuario: siembra, carga). */
  actorRole: ClinicRole | null;
  /** «Agendar igualmente»: motivo (5–300) de quien puede saltarse la reserva. */
  overrideReason?: string;
}

/** DX-446: reserva saltada con permiso; se deja en `audit_event`. */
export interface ReservedOverride {
  blockIds: string[];
  reason: string;
}

export interface BlockCheck {
  /** Avisos de los bloqueos que dejan agendar (almuerzo). */
  warnings: string[];
  override: ReservedOverride | null;
}

/** Código del 409 de un hueco reservado (la web ofrece «Agendar igualmente»). */
export const RESERVED_SLOT_CODE = 'RESERVED_SLOT';

/**
 * Bloqueos que tocan una cita (DX-122), al agendarla o moverla: si alguno NO
 * deja agendar encima, 409 con el motivo y el rango en la hora de la sede; si
 * solo hay bloqueos que lo permiten (almuerzo), devuelve sus avisos. Hora y
 * día en el formato y el reloj de la sede (G1-B), pedidos solo si hay algún
 * bloqueo que pintar: sin ellos, 409 `LOCATION_LOCALE_REQUIRED` (I4).
 *
 * DX-446: un bloque `RESERVED` deja pasar los tipos de `reservedForTypeIds`
 * y, desde «Liberar a partir de» (hora de la sede), cualquiera. Si no, 409
 * `RESERVED_SLOT` (con `canOverride`), salvo que quien agenda pueda saltarse la
 * reserva (ADMIN, odontólogo) y dé un motivo. Motivo sin permiso: 403.
 */
export async function checkScheduleBlocks(
  blocks: ScheduleBlockRepository,
  query: AffectingBlocksQuery,
  reserved: ReservedSlotContext,
): Promise<BlockCheck> {
  const reason = reserved.overrideReason?.trim();
  if (reserved.overrideReason !== undefined) {
    if (!canOverrideReserved(reserved.actorRole)) {
      throw new ForbiddenException(RESERVED_OVERRIDE_FORBIDDEN_MESSAGE);
    }
    const error = overrideReasonError(reserved.overrideReason);
    if (error !== null) throw new BadRequestException(error);
  }

  const found = await blocks.findAffecting(query);
  const { blocks: affecting, timeZone } = found;
  if (affecting.length === 0) return { warnings: [], override: null };
  const regular = affecting.filter(
    (b) => b.kind !== ScheduleBlockKind.RESERVED,
  );
  const fmt = () =>
    requireLocationFormat({
      id: found.locationId,
      locale: found.locale,
      hourCycle: found.hourCycle,
    });
  const blocking = regular.find((b) => !b.allowsBooking);
  if (blocking) {
    throw new ConflictException(
      blockConflictMessage(blocking, timeZone, fmt()),
    );
  }

  const pending = affecting.filter(
    (b) =>
      b.kind === ScheduleBlockKind.RESERVED &&
      evaluateReservedBlock(b, {
        appointmentTypeId: reserved.appointmentTypeId,
        now: reserved.now,
        timeZone,
      }) === 'RESERVED',
  );
  let override: ReservedOverride | null = null;
  if (pending.length > 0) {
    if (reason === undefined) {
      const ids = new Set(pending[0].reservedForTypeIds);
      const names = found.reservedTypes
        .filter((t) => ids.has(t.id))
        .map((t) => t.name);
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: RESERVED_SLOT_CODE,
        message: reservedConflictMessage(names),
        canOverride: canOverrideReserved(reserved.actorRole),
        allowedTypeIds: pending[0].reservedForTypeIds,
      });
    }
    override = { blockIds: pending.map((b) => b.id), reason };
  }

  if (regular.length === 0) return { warnings: [], override };
  const format = fmt();
  return {
    warnings: regular.map((b) => blockWarningMessage(b, timeZone, format)),
    override,
  };
}
