import { createHash, randomBytes } from 'node:crypto';

/**
 * Token de un enlace público por paciente (DX-443, DX-468): 32 bytes
 * aleatorios en base64url que viajan SOLO en el mensaje (email o WhatsApp) y
 * su SHA-256 en la BD. No se puede enumerar (256 bits) ni reconstruir desde la
 * BD. Lo comparten la copia del PDF firmado (DX-443) y la copia de la receta
 * (DX-468).
 */

const TOKEN_BYTES = 32;
// 32 bytes en base64url sin relleno = 43 caracteres URL-safe.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Token en texto plano: viaja SOLO en la URL, nunca se guarda. */
export function generatePublicLinkToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hash estable del token (hex), para guardar y buscar sin el texto plano. */
export function hashPublicLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Descarta en el acto lo que no puede ser un token (enumeración, enlaces truncados). */
export function isWellFormedPublicLinkToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}
