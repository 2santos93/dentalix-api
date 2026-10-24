import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
// 32 bytes en base64url sin relleno = 43 caracteres del alfabeto URL-safe.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Vigencia máxima del enlace (o hasta el inicio de la cita, lo que llegue antes). */
export const ANAMNESIS_LINK_TTL_DAYS = 7;
/** Ruta pública de la web (src/app/(public)/anamnesis/[token]). */
export const ANAMNESIS_PUBLIC_PATH = '/anamnesis';

/**
 * Token del enlace en texto plano. Viaja SOLO en la URL que recibe el
 * paciente (y en la respuesta que la crea, una vez); nunca se persiste ni se
 * registra (ver `hashAnamnesisToken`).
 */
export function generateAnamnesisToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hash estable del token, para guardar y buscar sin el texto plano. */
export function hashAnamnesisToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Descarta en el acto lo que no puede ser un token nuestro, sin consultar la BD. */
export function isWellFormedAnamnesisToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

/**
 * Caducidad de un enlace emitido en `now`: 7 días, o el inicio de la cita si
 * llega antes (la anamnesis es previa a la cita; después ya se hace en el
 * sillón).
 */
export function anamnesisLinkExpiry(
  now: Date,
  appointmentStart: Date | null,
): Date {
  const ttl = new Date(now.getTime() + ANAMNESIS_LINK_TTL_DAYS * DAY_MS);
  if (appointmentStart && appointmentStart.getTime() < ttl.getTime()) {
    return new Date(appointmentStart.getTime());
  }
  return ttl;
}

export function buildAnamnesisUrl(
  protocol: string,
  host: string,
  token: string,
): string {
  return `${protocol}://${host}${ANAMNESIS_PUBLIC_PATH}/${token}`;
}
