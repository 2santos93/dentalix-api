import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
// 32 bytes en base64url sin relleno = 43 caracteres del alfabeto URL-safe.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Vigencia del enlace público de indicaciones. */
export const POSTOP_LINK_TTL_DAYS = 30;
/** Ruta pública (sin sesión) donde el paciente abre sus indicaciones. */
export const POSTOP_PUBLIC_PATH = '/indicaciones';

/**
 * Token del enlace en texto plano. Viaja SOLO en la URL que recibe el
 * paciente; nunca se persiste (ver `hashPostOpToken`).
 */
export function generatePostOpToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hash estable del token, para guardar y buscar sin el texto plano. */
export function hashPostOpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Descarta en el acto lo que no puede ser un token nuestro, sin consultar la BD. */
export function isWellFormedPostOpToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

/** Fecha en que caduca un enlace emitido en `now`. */
export function postOpLinkExpiry(now: Date): Date {
  const expiry = new Date(now.getTime());
  expiry.setUTCDate(expiry.getUTCDate() + POSTOP_LINK_TTL_DAYS);
  return expiry;
}

export function buildPostOpUrl(
  protocol: string,
  host: string,
  token: string,
): string {
  return `${protocol}://${host}${POSTOP_PUBLIC_PATH}/${token}`;
}
