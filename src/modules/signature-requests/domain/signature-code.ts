import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';

/** Vigencia de cada código enviado. */
export const SIGNATURE_CODE_TTL_MINUTES = 10;
/** Fallos que bloquean el enlace (en total, aunque se pidan códigos nuevos). */
export const SIGNATURE_CODE_MAX_ATTEMPTS = 5;
/** Códigos que se pueden pedir por enlace. */
export const SIGNATURE_CODE_MAX_SENDS = 5;
/** Espera mínima entre dos envíos del código. */
export const SIGNATURE_CODE_RESEND_SECONDS = 60;

const CODE_SHAPE = /^\d{6}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HKDF_SALT = 'dentalix';
const HKDF_INFO = 'signature-request-code-v1';

/** Seis dígitos uniformes (000000–999999) con el CSPRNG del sistema. */
export function generateSignatureCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isWellFormedSignatureCode(code: string): boolean {
  return CODE_SHAPE.test(code);
}

/**
 * Clave del HMAC del código, derivada (HKDF) de un secreto del servidor que
 * no vive en la base. Con un hash sin clave, un volcado de la base bastaría
 * para probar el millón de códigos posibles.
 */
export function deriveSignatureCodeKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, 32));
}

/** HMAC-SHA256 (hex) del código, atado a su solicitud. */
export function hmacSignatureCode(
  key: Buffer,
  requestId: string,
  code: string,
): string {
  return createHmac('sha256', key).update(`${requestId}:${code}`).digest('hex');
}

/** Compara en tiempo constante con el HMAC guardado. */
export function signatureCodeMatches(
  key: Buffer,
  requestId: string,
  code: string,
  stored: string,
): boolean {
  if (!isWellFormedSignatureCode(code) || !HEX_SHA256.test(stored)) {
    return false;
  }
  const expected = Buffer.from(hmacSignatureCode(key, requestId, code), 'hex');
  return timingSafeEqual(expected, Buffer.from(stored, 'hex'));
}

export function signatureCodeExpiry(now: Date): Date {
  return new Date(now.getTime() + SIGNATURE_CODE_TTL_MINUTES * 60_000);
}

/** Segundos que faltan para poder pedir otro código (0 = ya se puede). */
export function codeResendWaitSeconds(
  lastSentAt: Date | null,
  now: Date,
): number {
  if (!lastSentAt) return 0;
  const elapsedMs = now.getTime() - lastSentAt.getTime();
  const waitMs = SIGNATURE_CODE_RESEND_SECONDS * 1000 - elapsedMs;
  return waitMs > 0 ? Math.ceil(waitMs / 1000) : 0;
}
