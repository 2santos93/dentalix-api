import { ClinicRole, ScheduleBlockKind } from '@prisma/client';
import type { ScheduleBlock } from './entities/schedule-block.entity';
import type { ScheduleBlockScope } from './ports/schedule-block-repository.port';
import type {
  RegionalFormat,
  WallParts,
} from '../../../shared/format/regional-format';
import { endSentence } from '../../../shared/format/end-sentence';

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
  [ScheduleBlockKind.RESERVED]: 'Reservado',
};

export const SCHEDULE_BLOCK_NOT_FOUND_MESSAGE = 'Bloqueo no encontrado';

/** Tope de citas afectadas que se devuelven (el total se dice aparte). */
export const MAX_AFFECTED_APPOINTMENTS = 50;

/**
 * Quién tiene agenda de pacientes: odontología y administración (el titular).
 * Recepción y asistencia no atienden, así que ni se les bloquea la agenda ni se
 * les buscan huecos (revisión de DX-122).
 */
export const ATTENDING_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];
export const NOT_ATTENDING_MESSAGE =
  'Ese miembro del equipo no atiende pacientes: no tiene agenda que bloquear ni huecos que buscar.';
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

/** ¿Dos horas de pared caen en el mismo día civil de la sede? */
function sameDay(a: WallParts, b: WallParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

const atMidnight = (wall: WallParts): boolean =>
  wall.hour === 0 && wall.minute === 0;

/**
 * «del 20/10 08:00 al 24/10 19:00», el mismo día «13:00–14:00» y, si son días
 * completos (de medianoche a medianoche en la sede), «del 21/10 al 22/10» o
 * «el 21/10»: el último día que eligió quien bloqueó, no «al 23/10 00:00».
 * Día y hora en el formato y el reloj de la sede (G1-B); qué es día completo
 * o el mismo día se decide con `wallParts`, nunca comparando texto (R13).
 */
function describeRange(
  block: ScheduleBlock,
  timeZone: string,
  fmt: RegionalFormat,
  sameDayShort: boolean,
): string {
  const from = fmt.wallParts(block.start, timeZone);
  const to = fmt.wallParts(block.end, timeZone);
  const day = (instant: Date) => fmt.dayMonth(instant, timeZone);
  const time = (instant: Date) => fmt.time(instant, timeZone);
  if (atMidnight(from) && atMidnight(to)) {
    const lastInstant = new Date(block.end.getTime() - 60_000);
    return sameDay(fmt.wallParts(lastInstant, timeZone), from)
      ? `el ${day(block.start)}`
      : `del ${day(block.start)} al ${day(lastInstant)}`;
  }
  if (sameDayShort && sameDay(from, to))
    return `${time(block.start)}–${time(block.end)}`;
  return `del ${day(block.start)} ${time(block.start)} al ${day(block.end)} ${time(block.end)}`;
}

/** 409 al agendar o mover encima de un bloqueo que no lo permite. */
export function blockConflictMessage(
  block: ScheduleBlock,
  timeZone: string,
  fmt: RegionalFormat,
): string {
  const who =
    block.providerId === null
      ? 'La sede tiene la agenda bloqueada'
      : 'La agenda del profesional está bloqueada';
  const kind = SCHEDULE_BLOCK_KIND_LABELS[block.kind];
  return `${endSentence(`${who} (${kind}) ${describeRange(block, timeZone, fmt, false)}`)} Elige otro horario.`;
}

/** Aviso (no error) al agendar dentro de un bloqueo con `allowsBooking`. */
export function blockWarningMessage(
  block: ScheduleBlock,
  timeZone: string,
  fmt: RegionalFormat,
): string {
  const kind = SCHEDULE_BLOCK_KIND_LABELS[block.kind];
  return `La cita cae en un bloqueo que permite agendar: ${kind} (${describeRange(block, timeZone, fmt, true)}).`;
}
