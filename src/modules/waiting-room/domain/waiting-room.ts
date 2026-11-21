import { createHmac } from 'node:crypto';
import { WaitingRoomNameMode } from '@prisma/client';

/**
 * DX-588: la pantalla de sala de espera (el televisor). Reglas puras: las
 * comparten los casos de uso (400/404/409 en español), el tablero público y
 * los tests. La migración repite las del nombre y los mensajes como CHECK.
 *
 * La sala de espera la ve cualquiera: el tablero lleva el MÍNIMO de datos por
 * diseño (nombre visible o turno, estado, sillón y profesional al pasar, y
 * minutos), nunca motivo, tratamiento, teléfono, documento ni importes.
 */

export const SCREEN_NAME_MAX = 60;
export const SCREEN_MESSAGES_MAX = 5;
export const SCREEN_MESSAGE_MAX = 140;
/** Sondeo del televisor: «llega en menos de 15 s» con margen (decisión DX-588). */
export const BOARD_REFRESH_SECONDS = 8;
/** Filas por columna como mucho (el televisor recorta con «y N más»). */
export const BOARD_COLUMN_LIMIT = 40;

export const WAITING_ROOM_SCREEN_NOT_FOUND_MESSAGE =
  'Pantalla de sala de espera no encontrada';
export const WAITING_ROOM_SCREEN_REVOKED_MESSAGE =
  'Esta pantalla ya está revocada: crea una nueva para volver a usar el televisor.';
export const WAITING_ROOM_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada';
export const WAITING_ROOM_WRITE_FORBIDDEN_MESSAGE =
  'Solo administración gestiona las pantallas de sala de espera.';
/** El MISMO 404 para token mal formado, desconocido, de otra clínica o revocado. */
export const WAITING_ROOM_SCREEN_INACTIVE_CODE = 'WAITING_ROOM_SCREEN_INACTIVE';
export const WAITING_ROOM_SCREEN_INACTIVE_MESSAGE =
  'Esta pantalla ya no está activa.';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

const length = (text: string) => Array.from(text).length;

export function normalizeScreenName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function screenNameError(name: string): string | null {
  const trimmed = normalizeScreenName(name);
  if (trimmed === '') return 'Escribe un nombre para la pantalla.';
  if (length(trimmed) > SCREEN_NAME_MAX) {
    return `El nombre de la pantalla admite hasta ${SCREEN_NAME_MAX} caracteres.`;
  }
  if (CONTROL.test(trimmed)) {
    return 'El nombre de la pantalla no puede tener caracteres de control.';
  }
  return null;
}

/** Recorta cada mensaje y quita los vacíos (la web manda filas en blanco). */
export function normalizeScreenMessages(messages: readonly string[]): string[] {
  return messages
    .map((m) => m.trim().replace(/[ \t]+/g, ' '))
    .filter((m) => m !== '');
}

export function screenMessagesError(
  messages: readonly string[],
): string | null {
  if (messages.length > SCREEN_MESSAGES_MAX) {
    return `Puedes poner hasta ${SCREEN_MESSAGES_MAX} mensajes.`;
  }
  for (const message of messages) {
    if (length(message) > SCREEN_MESSAGE_MAX) {
      return `Cada mensaje admite hasta ${SCREEN_MESSAGE_MAX} caracteres.`;
    }
    if (CONTROL.test(message)) {
      return 'Los mensajes no pueden tener saltos de línea ni caracteres de control.';
    }
  }
  return null;
}

/** Primera palabra de un texto (sin espacios de más), o null. */
function firstWord(text: string | null): string | null {
  const word = text?.trim().split(/\s+/)[0] ?? '';
  return word === '' ? null : word;
}

/**
 * «Ana R.»: el primer nombre y la inicial del primer apellido. Sin apellido,
 * solo el nombre; sin nada, «Paciente». La inicial por punto de código (una
 * «Ñ» o una letra con tilde no se parten).
 */
export function nameInitialLabel(
  firstName: string | null,
  lastName: string | null,
): string {
  const first = firstWord(firstName);
  const initial = Array.from(firstWord(lastName) ?? '')[0];
  if (!first)
    return initial ? `${initial.toLocaleUpperCase('es')}.` : 'Paciente';
  return initial ? `${first} ${initial.toLocaleUpperCase('es')}.` : first;
}

/** «Turno 7»; sin número (llegó antes de DX-588), «Turno —». Nunca un nombre. */
export function turnLabel(turnNumber: number | null): string {
  return turnNumber === null ? 'Turno —' : `Turno ${turnNumber}`;
}

/** Lo que el televisor muestra de la persona según el modo de la pantalla. */
export function displayLabel(
  mode: WaitingRoomNameMode,
  person: {
    firstName: string | null;
    lastName: string | null;
    turnNumber: number | null;
  },
): string {
  return mode === WaitingRoomNameMode.TURN_NUMBER
    ? turnLabel(person.turnNumber)
    : nameInitialLabel(person.firstName, person.lastName);
}

/**
 * Clave estable y OPACA de una persona en el tablero: HMAC-SHA256 (clave = id
 * de la pantalla) del id de la cita, 16 hex. La misma entre sondeos (el
 * televisor la usa para destacar a quien acaba de pasar) sin exponer ids
 * internos; de otra pantalla, otra clave.
 */
export function boardKey(screenId: string, appointmentId: string): string {
  return createHmac('sha256', screenId)
    .update(appointmentId)
    .digest('hex')
    .slice(0, 16);
}
