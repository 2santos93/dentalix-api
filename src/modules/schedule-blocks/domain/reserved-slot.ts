import { ClinicRole, ScheduleBlockKind } from '@prisma/client';
import { civilDateIn, zonedWallTime } from '../../../shared/time/civil-day';

/**
 * Huecos reservados (DX-446). Un bloque `RESERVED` guarda un tramo de la
 * agenda de un profesional (o de toda la sede) para ciertos tipos de cita
 * (p. ej. «Consulta de urgencia»):
 * - una cita de un tipo de `reservedForTypeIds` cabe siempre;
 * - cualquier otra, solo si ya pasó «Liberar a partir de» (`releaseAtMinute`,
 *   hora de PARED de la sede del día del bloque, con el reloj del servidor);
 * - o si quien agenda tiene permiso de saltarse la reserva y da un motivo
 *   (queda en `audit_event`).
 */

/** Tope de tipos por bloque (CHECK `schedule_blocks_reserved_check`). */
export const MAX_RESERVED_TYPES = 20;
export const OVERRIDE_REASON_MIN = 5;
export const OVERRIDE_REASON_MAX = 300;
const MINUTES_PER_DAY = 24 * 60;

/**
 * Quién puede agendar igualmente en un hueco reservado. No hay permisos finos
 * en Dentalix (solo roles por clínica): gestión (ADMIN) y el odontólogo, que
 * decide clínicamente; recepción y asistencia, no.
 */
export const RESERVED_OVERRIDE_ROLES: readonly ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.DENTIST,
];

export const RESERVED_OVERRIDE_FORBIDDEN_MESSAGE =
  'No tienes permiso para agendar en un hueco reservado. Pide a un odontólogo o a la administración que lo haga.';
export const RESERVED_TYPE_NOT_FOUND_MESSAGE = 'Tipo de cita no encontrado';
export const RESERVED_TYPE_INACTIVE_MESSAGE =
  'Un tipo de cita reservado está desactivado: actívalo o elige otro.';

export function canOverrideReserved(role: ClinicRole | null): boolean {
  return role !== null && RESERVED_OVERRIDE_ROLES.includes(role);
}

/** Motivo del override: 5–300 caracteres tras recortar, en una sola línea. */
export function overrideReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (
    trimmed.length < OVERRIDE_REASON_MIN ||
    trimmed.length > OVERRIDE_REASON_MAX
  ) {
    return `El motivo para agendar en un hueco reservado debe tener entre ${OVERRIDE_REASON_MIN} y ${OVERRIDE_REASON_MAX} caracteres.`;
  }
  return /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(trimmed)
    ? 'El motivo para agendar en un hueco reservado va en una sola línea.'
    : null;
}

/** 409 al agendar un tipo no permitido en un hueco reservado sin liberar. */
export function reservedConflictMessage(typeNames: string[]): string {
  return `Ese horario está reservado para urgencias (${typeNames.join(', ')}). Elige otro hueco o usa un tipo permitido.`;
}

export interface ReservedBlockFields {
  kind: ScheduleBlockKind;
  start: Date;
  end: Date;
  reservedForTypeIds: string[];
  releaseAtMinute: number | null;
}

/**
 * Instante de «Liberar a partir de»: la hora de pared `releaseAtMinute` del
 * día civil (en la sede) en que empieza el bloque. `null` = no se libera.
 */
export function releaseInstant(
  block: ReservedBlockFields,
  timeZone: string,
): Date | null {
  if (block.kind !== ScheduleBlockKind.RESERVED) return null;
  if (block.releaseAtMinute === null) return null;
  return zonedWallTime(
    civilDateIn(block.start, timeZone),
    block.releaseAtMinute,
    timeZone,
  );
}

export function isReleased(
  block: ReservedBlockFields,
  timeZone: string,
  now: Date,
): boolean {
  const at = releaseInstant(block, timeZone);
  return at !== null && now.getTime() >= at.getTime();
}

export type ReservedVerdict = 'ALLOWED_TYPE' | 'RELEASED' | 'RESERVED';

/** ¿Cabe una cita de `appointmentTypeId` en este hueco reservado AHORA? */
export function evaluateReservedBlock(
  block: ReservedBlockFields,
  ctx: { appointmentTypeId: string | null; now: Date; timeZone: string },
): ReservedVerdict {
  if (
    ctx.appointmentTypeId !== null &&
    block.reservedForTypeIds.includes(ctx.appointmentTypeId)
  ) {
    return 'ALLOWED_TYPE';
  }
  return isReleased(block, ctx.timeZone, ctx.now) ? 'RELEASED' : 'RESERVED';
}

export interface ReservedBlockShape extends ReservedBlockFields {
  locationId: string | null;
  allowsBooking: boolean;
}

/** Minutos desde las 00:00 de pared de `instant` en `timeZone`. */
function wallMinute(instant: Date, timeZone: string): number {
  const day = civilDateIn(instant, timeZone);
  return Math.round(
    (instant.getTime() - zonedWallTime(day, 0, timeZone).getTime()) / 60_000,
  );
}

/**
 * Forma de un bloque según su tipo (la CHECK de la tabla, con mensajes en
 * español, más lo que la CHECK no puede saber: la zona de la sede). Un
 * reservado: 1–20 tipos, con sede, sin «Permitir agendar», dentro de un solo
 * día de la sede y con la liberación antes de su inicio. Los demás tipos, ni
 * tipos reservados ni liberación.
 */
export function reservedBlockShapeError(
  block: ReservedBlockShape,
  timeZone: string | null,
): string | null {
  if (block.kind !== ScheduleBlockKind.RESERVED) {
    return block.reservedForTypeIds.length > 0 || block.releaseAtMinute !== null
      ? 'Solo un bloque «Reservado» lleva tipos de cita permitidos y hora de liberación.'
      : null;
  }
  if (block.reservedForTypeIds.length === 0) {
    return 'Elige al menos un tipo de cita para el hueco reservado.';
  }
  if (block.reservedForTypeIds.length > MAX_RESERVED_TYPES) {
    return `Un hueco reservado admite como mucho ${MAX_RESERVED_TYPES} tipos de cita.`;
  }
  if (block.locationId === null || timeZone === null) {
    return 'Un hueco reservado es de una sede: indica la sede.';
  }
  if (block.allowsBooking) {
    return 'Un hueco reservado no admite «Permitir agendar»: usa «Liberar a partir de».';
  }
  const lastInstant = new Date(block.end.getTime() - 1);
  if (
    civilDateIn(block.start, timeZone) !== civilDateIn(lastInstant, timeZone)
  ) {
    return 'Un hueco reservado tiene que caber en un solo día.';
  }
  if (block.releaseAtMinute !== null) {
    if (
      !Number.isInteger(block.releaseAtMinute) ||
      block.releaseAtMinute < 0 ||
      block.releaseAtMinute >= MINUTES_PER_DAY
    ) {
      return 'Indica una hora válida para «Liberar a partir de».';
    }
    if (block.releaseAtMinute >= wallMinute(block.start, timeZone)) {
      return '«Liberar a partir de» tiene que ser antes del inicio del hueco reservado.';
    }
  }
  return null;
}
