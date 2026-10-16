import { createHash, randomBytes } from 'node:crypto';

/** Vigencia del enlace de restablecimiento (OWASP: corta). */
export const PASSWORD_RESET_TTL_MINUTES = 30;

/** Ruta pública de la web (src/app/(auth)/restablecer/[token]). */
export const PASSWORD_RESET_PATH = '/restablecer';

/** 32 bytes aleatorios en base64url (43 caracteres, sin relleno). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Token del enlace en claro. Solo viaja en el email; en la BD queda su hash
 * (`hashPasswordResetToken`). 32 bytes de `randomBytes` (CSPRNG).
 */
export function generatePasswordResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 (hex) del token: lo único que se guarda y por lo que se busca. */
export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * ¿Tiene la forma de un token nuestro? Lo que no la tiene no llega a la BD
 * (y cuenta como inexistente).
 */
export function isWellFormedPasswordResetToken(
  token: unknown,
): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

export function passwordResetExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000);
}

/**
 * Estado de un enlace tal como lo ve quien lo abre:
 * - VALID: se puede usar.
 * - EXPIRED: pasaron los 30 min.
 * - USED: ya se usó.
 * - INVALID: no existe, se pidió otro más reciente o no vale en esta clínica.
 */
export type PasswordResetTokenStatus = 'VALID' | 'EXPIRED' | 'USED' | 'INVALID';

export interface StoredResetToken {
  expiresAt: Date;
  usedAt: Date | null;
  invalidatedAt: Date | null;
}

/** Precedencia: usado > reemplazado > caducado > válido. */
export function passwordResetTokenStatus(
  token: StoredResetToken | null,
  now: Date,
): PasswordResetTokenStatus {
  if (!token) return 'INVALID';
  if (token.usedAt) return 'USED';
  if (token.invalidatedAt) return 'INVALID';
  if (token.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'VALID';
}
