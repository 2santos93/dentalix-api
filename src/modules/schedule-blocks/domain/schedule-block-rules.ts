import { ScheduleBlockKind } from '@prisma/client';
import type { ScheduleBlock } from './entities/schedule-block.entity';
import type { ScheduleBlockScope } from './ports/schedule-block-repository.port';

/** Un bloqueo dura como mucho un año (una baja larga cabe; un error de año, no). */
export const MAX_BLOCK_DAYS = 366;
/** Rango máximo de `GET /schedule-blocks` (la vista Mes pide ~6 semanas). */
export const MAX_BLOCK_LIST_DAYS = 92;
export const BLOCK_NOTE_MAX_LENGTH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export const SCHEDULE_BLOCK_KIND_LABELS: Record<ScheduleBlockKind, string> = {
  [ScheduleBlockKind.VACATION]: 'Vacaciones',
  [ScheduleBlockKind.MEETING]: 'Reunión',
  [ScheduleBlockKind.LUNCH]: 'Almuerzo',
  [ScheduleBlockKind.OTHER]: 'Bloqueo',
};

export const SCHEDULE_BLOCK_NOT_FOUND_MESSAGE = 'Bloqueo no encontrado';
export const SCHEDULE_BLOCK_OWN_ONLY_MESSAGE =
  'Solo puedes bloquear o cambiar tu propia agenda.';

export function scheduleBlockRangeError(start: Date, end: Date): string | null {
  if (end.getTime() <= start.getTime()) {
    return 'La hora de fin del bloqueo tiene que ser posterior a la de inicio';
  }
  if (end.getTime() - start.getTime() > MAX_BLOCK_DAYS * DAY_MS) {
    return `Un bloqueo puede durar como mucho ${MAX_BLOCK_DAYS} días`;
  }
  return null;
}

export function scheduleBlockScopeError(
  scope: ScheduleBlockScope,
): string | null {
  return scope.providerId === null && scope.locationId === null
    ? 'Indica la sede o el profesional del bloqueo'
    : null;
}

export function scheduleBlockNoteError(note: string): string | null {
  const trimmed = note.trim();
  if (trimmed.length === 0) return 'La nota del bloqueo no puede estar vacía';
  if (trimmed.length > BLOCK_NOTE_MAX_LENGTH) {
    return `La nota del bloqueo admite como mucho ${BLOCK_NOTE_MAX_LENGTH} caracteres`;
  }
  return null;
}

/**
 * ¿El bloqueo afecta a una cita de `providerId` en `locationId`? (el solape de
 * horas se mira aparte). Ver el alcance en `ScheduleBlock`.
 */
export function blockAffects(
  block: Pick<ScheduleBlock, 'providerId' | 'locationId'>,
  providerId: string,
  locationId: string,
): boolean {
  if (block.providerId === null) return block.locationId === locationId;
  return (
    block.providerId === providerId &&
    (block.locationId === null || block.locationId === locationId)
  );
}

/** ¿`[start, end)` y el bloqueo se solapan? (medio abierto, como las citas). */
export function overlapsBlock(
  block: Pick<ScheduleBlock, 'start' | 'end'>,
  start: Date,
  end: Date,
): boolean {
  return block.start < end && block.end > start;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(instant: Date, timeZone: string): Record<string, string> {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('es-CO', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return Object.fromEntries(
    formatter.formatToParts(instant).map((p) => [p.type, p.value]),
  );
}

function dayAndTime(
  instant: Date,
  timeZone: string,
): { day: string; time: string } {
  const p = wallParts(instant, timeZone);
  return { day: `${p.day}/${p.month}`, time: `${p.hour}:${p.minute}` };
}

/** «del 20/10 08:00 al 24/10 19:00» o, el mismo día, «13:00–14:00». */
function describeRange(
  block: ScheduleBlock,
  timeZone: string,
  sameDayShort: boolean,
): string {
  const from = dayAndTime(block.start, timeZone);
  const to = dayAndTime(block.end, timeZone);
  if (sameDayShort && from.day === to.day) return `${from.time}–${to.time}`;
  return `del ${from.day} ${from.time} al ${to.day} ${to.time}`;
}

/** 409 al agendar o mover encima de un bloqueo que no lo permite. */
export function blockConflictMessage(
  block: ScheduleBlock,
  timeZone: string,
): string {
  const who =
    block.providerId === null
      ? 'La sede tiene la agenda bloqueada'
      : 'La agenda del profesional está bloqueada';
  const kind = SCHEDULE_BLOCK_KIND_LABELS[block.kind];
  return `${who} (${kind}) ${describeRange(block, timeZone, false)}. Elige otro horario.`;
}

/** Aviso (no error) al agendar dentro de un bloqueo con `allowsBooking`. */
export function blockWarningMessage(
  block: ScheduleBlock,
  timeZone: string,
): string {
  const kind = SCHEDULE_BLOCK_KIND_LABELS[block.kind];
  return `La cita cae en un bloqueo que permite agendar: ${kind} (${describeRange(block, timeZone, true)}).`;
}
