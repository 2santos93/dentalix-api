import { createHash, timingSafeEqual } from 'node:crypto';
import { docKey } from '../../patients/domain/doc-key';

/**
 * DX-265: identificación con el QR de la sede. El paciente escribe su número
 * de documento y su fecha de nacimiento; solo se buscan las citas de HOY en
 * ESA sede (nunca se listan nombres) y la respuesta de un fallo es la misma
 * exista o no el paciente. Tras 5 fallos desde la misma IP en la sede, 15
 * minutos de bloqueo (contador en la BD, atómico).
 */

export const CHECK_IN_MAX_FAILURES = 5;
/**
 * Tope por documento, MAYOR que por IP: quien conoce el documento de otro
 * puede bloquearle el QR fallando adrede (riesgo aceptado: el paciente pasa
 * por recepción); con 10 cuesta el doble y la IP sigue frenando en 5.
 */
export const CHECK_IN_DOCUMENT_MAX_FAILURES = 10;
export const CHECK_IN_LOCK_MINUTES = 15;
/** Ventana en la que se acumulan los fallos (después, empieza de cero). */
export const CHECK_IN_FAILURE_WINDOW_MINUTES = 15;
/** Suelo de tiempo de toda respuesta de identificación (acierto o fallo). */
export const CHECK_IN_RESPONSE_FLOOR_MS = 400;
/** Tope de lo que se acepta escribir como documento. */
export const CHECK_IN_DOCUMENT_MAX = 40;

export const CHECK_IN_NO_MATCH_CODE = 'CHECK_IN_NO_MATCH';
/** La ÚNICA respuesta de un fallo: no dice si el paciente existe ni por qué falla. */
export const CHECK_IN_NO_MATCH_MESSAGE =
  'No encontramos una cita para hoy en esta sede con esos datos. Revisa el documento y la fecha de nacimiento, o pasa por recepción.';
export const CHECK_IN_LOCKED_CODE = 'CHECK_IN_LOCKED';
export const CHECK_IN_LOCKED_MESSAGE =
  'Demasiados intentos. Por seguridad, espera unos minutos o pasa por recepción.';
export const CHECK_IN_QR_INACTIVE_CODE = 'CHECK_IN_QR_INACTIVE';
export const CHECK_IN_QR_INACTIVE_MESSAGE =
  'Este código ya no está activo. Pasa por recepción.';

/**
 * Clave de comparación del documento escrito: la de DX-107 (solo [0-9A-Z]).
 * `null` si no queda nada o es demasiado largo.
 */
export function normalizeCheckInDocument(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > CHECK_IN_DOCUMENT_MAX) return null;
  const key = docKey(value);
  return key.length >= 3 ? key : null;
}

/** Las letras del principio de la clave («V12345678» → «12345678»). */
function withoutLetterPrefix(key: string): string {
  return key.replace(/^[A-Z]+/, '');
}

/** Comparación de dos cadenas en tiempo constante (por sus SHA-256). */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(`ci:${a}`).digest();
  const hb = createHash('sha256').update(`ci:${b}`).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * ¿El documento escrito es el guardado? Misma clave, o (si se escribió sin
 * letras) los mismos dígitos tras la letra de tipo: en Venezuela se escribe
 * «12345678» por «V-12345678». Las dos comparaciones se hacen siempre.
 */
export function documentMatches(given: string, stored: string | null): boolean {
  const storedKey = stored === null ? '\u0000' : docKey(stored);
  const exact = constantTimeEquals(given, storedKey);
  const digitsOnly = /^[0-9]+$/.test(given);
  const loose = constantTimeEquals(
    digitsOnly ? given : `\u0001${given}`,
    withoutLetterPrefix(storedKey),
  );
  return stored !== null && (exact || loose);
}

/**
 * Clave del cliente para el contador de fallos: SHA-256 de la clínica, la
 * sede y la IP. Nunca se guarda la IP.
 */
export function checkInClientKey(
  tenantId: string,
  locationId: string,
  ip: string | null,
): string {
  return createHash('sha256')
    .update(`check-in:${tenantId}:${locationId}:${ip ?? 'unknown'}`)
    .digest('hex');
}

/**
 * Clave del contador por DOCUMENTO en la sede: SHA-256 de la clínica, la sede
 * y la clave del documento escrito (DX-107, sin la letra de tipo para que
 * «V-12345678» y «12345678» cuenten juntos). Nunca se guarda el documento.
 * Lo que no es un documento válido cuenta en su propio balde.
 */
export function checkInDocumentKey(
  tenantId: string,
  locationId: string,
  documentNumber: unknown,
): string {
  const key = normalizeCheckInDocument(documentNumber);
  const bucket = key
    ? `doc:${withoutLetterPrefix(key)}`
    : `invalid:${typeof documentNumber === 'string' ? documentNumber.trim().toUpperCase().slice(0, CHECK_IN_DOCUMENT_MAX) : ''}`;
  return createHash('sha256')
    .update(`check-in-doc:${tenantId}:${locationId}:${bucket}`)
    .digest('hex');
}

export interface CheckInAttemptState {
  failedAttempts: number;
  firstFailedAt: Date;
  lockedUntil: Date | null;
}

/** ¿Sigue bloqueado este cliente en `now`? */
export function lockedUntil(
  state: CheckInAttemptState | null,
  now: Date,
): Date | null {
  if (!state?.lockedUntil) return null;
  return state.lockedUntil.getTime() > now.getTime() ? state.lockedUntil : null;
}

/** Segundos de Retry-After (al menos 1). */
export function retryAfterSeconds(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}
