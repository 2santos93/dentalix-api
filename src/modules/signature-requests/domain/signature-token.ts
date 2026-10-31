import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
// 32 bytes en base64url sin relleno = 43 caracteres del alfabeto URL-safe.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Vigencia del enlace por defecto (DX-243: 72 h). */
export const SIGNATURE_LINK_TTL_HOURS = 72;
/** Lo que dura la sesión del navegador que verificó el código. */
export const SIGNATURE_SESSION_TTL_MINUTES = 30;
/** Ruta pública de la web (src/app/(public)/firmar/[token]). */
export const SIGNATURE_PUBLIC_PATH = '/firmar';

/**
 * Secreto aleatorio en texto plano: el token del enlace (viaja SOLO en la URL
 * del email) y la sesión que recibe el navegador al verificar el código. Ni
 * uno ni otro se guardan ni se registran: solo su hash.
 */
export function generateSignatureToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hash estable del token o de la sesión, para guardar y buscar sin el texto plano. */
export function hashSignatureToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Descarta en el acto lo que no puede ser un token nuestro, sin consultar la BD. */
export function isWellFormedSignatureToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

export function signatureLinkExpiry(now: Date): Date {
  return new Date(now.getTime() + SIGNATURE_LINK_TTL_HOURS * HOUR_MS);
}

/** 30 minutos desde la verificación, o la caducidad del enlace si llega antes. */
export function signatureSessionExpiry(now: Date, linkExpiresAt: Date): Date {
  const session = now.getTime() + SIGNATURE_SESSION_TTL_MINUTES * MINUTE_MS;
  return new Date(Math.min(session, linkExpiresAt.getTime()));
}

export function buildSignatureUrl(
  protocol: string,
  host: string,
  token: string,
): string {
  return `${protocol}://${host}${SIGNATURE_PUBLIC_PATH}/${token}`;
}
