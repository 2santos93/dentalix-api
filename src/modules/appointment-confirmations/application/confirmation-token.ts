import { createHash, randomBytes } from 'node:crypto';
import { AppointmentStatus } from '@prisma/client';
import { ConfirmationState } from '../domain/entities/appointment-confirmation.entity';

const TOKEN_BYTES = 32;
// 32 bytes en base64url sin relleno = 43 caracteres del alfabeto URL-safe.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Token del enlace de confirmación en texto plano. Viaja SOLO en la URL que
 * recibe el paciente; nunca se persiste (ver `hashConfirmationToken`).
 * base64url en vez de hex para que el enlace de WhatsApp sea más corto.
 */
export function generateConfirmationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hash estable del token, para guardar y buscar sin el texto plano. */
export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Descarta en el acto lo que no puede ser un token nuestro (enumeración,
 * enlaces truncados por el cliente de mensajería) sin consultar la BD.
 */
export function isWellFormedConfirmationToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

export interface ConfirmationSnapshot {
  expiresAt: Date;
  appointmentStart: Date;
  appointmentStatus: AppointmentStatus;
  respondedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Estado del enlace, por precedencia: respondido > caducado/no válido >
 * pendiente. "Caducado" agrupa todo lo que deja el enlace sin efecto: se
 * revocó (recepción emitió otro), llegó el inicio de la cita, la cita ya no
 * existe, o se reagendó / cambió de estado después de emitirlo (la foto
 * `appointmentStart`/`appointmentStatus` ya no coincide).
 */
export function confirmationState(
  confirmation: ConfirmationSnapshot,
  appointment: { start: Date; status: AppointmentStatus } | null,
  now: Date,
): ConfirmationState {
  if (confirmation.respondedAt) return 'RESPONDED';
  if (confirmation.revokedAt) return 'EXPIRED';
  if (confirmation.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (!appointment) return 'EXPIRED';
  if (appointment.start.getTime() !== confirmation.appointmentStart.getTime()) {
    return 'EXPIRED';
  }
  if (appointment.status !== confirmation.appointmentStatus) return 'EXPIRED';
  return 'PENDING';
}

/** Nombre de pila: la primera palabra del nombre (la página pública no muestra más). */
export function firstNameOnly(firstName: string | null): string | null {
  const first = firstName?.trim().split(/\s+/)[0];
  return first ? first : null;
}
