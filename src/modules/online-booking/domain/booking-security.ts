import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * DX-016: piezas de seguridad de la página pública de reserva. Molde del
 * código de la firma a distancia (DX-243): HMAC con clave HKDF del servidor
 * (un volcado de la base no basta para probar el millón de códigos).
 */

/** Vigencia del código del email. */
export const BOOKING_CODE_TTL_MINUTES = 10;
/** Fallos que bloquean el código (y su verificación). */
export const BOOKING_CODE_MAX_ATTEMPTS = 5;
/** Códigos por paciente en una hora: pasado el tope no se envía nada más. */
export const BOOKING_CODES_PER_HOUR = 5;
/** Sesión tras verificar (o tras crear la ficha nueva). */
export const BOOKING_SESSION_TTL_MINUTES = 30;
/** Tiempo mínimo y máximo de rellenado del formulario. */
export const FORM_MIN_FILL_SECONDS = 4;
export const FORM_MAX_AGE_SECONDS = 2 * 60 * 60;

const CODE_SHAPE = /^\d{6}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const HKDF_SALT = 'dentalix';

export function deriveBookingKey(secret: string, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, HKDF_SALT, `online-booking-${purpose}-v1`, 32),
  );
}

export function generateBookingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isWellFormedBookingCode(code: unknown): code is string {
  return typeof code === 'string' && CODE_SHAPE.test(code);
}

export function hmacBookingCode(
  key: Buffer,
  verificationId: string,
  code: string,
): string {
  return createHmac('sha256', key)
    .update(`${verificationId}:${code}`)
    .digest('hex');
}

export function bookingCodeMatches(
  key: Buffer,
  verificationId: string,
  code: string,
  stored: string | null,
): boolean {
  if (!stored || !isWellFormedBookingCode(code) || !HEX64.test(stored)) {
    return false;
  }
  const expected = Buffer.from(
    hmacBookingCode(key, verificationId, code),
    'hex',
  );
  return timingSafeEqual(expected, Buffer.from(stored, 'hex'));
}

/** Token de sesión: 32 bytes en base64url (43 caracteres). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isWellFormedSessionToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Token del formulario: la hora de emisión firmada para ESTA clínica. Mide
 * el tiempo de rellenado sin fiarse del reloj del navegador: un bot que
 * envía al instante, o con un token de otra clínica, no pasa.
 */
export function issueFormToken(
  key: Buffer,
  tenantId: string,
  now: Date,
): string {
  const issued = String(now.getTime());
  const mac = createHmac('sha256', key)
    .update(`${tenantId}:${issued}`)
    .digest('base64url');
  return `${issued}.${mac}`;
}

export type FormTokenCheck = 'OK' | 'INVALID' | 'TOO_FAST' | 'EXPIRED';

export function checkFormToken(
  key: Buffer,
  tenantId: string,
  token: unknown,
  now: Date,
): FormTokenCheck {
  if (typeof token !== 'string' || token.length > 100) return 'INVALID';
  const [issued, mac, extra] = token.split('.');
  if (extra !== undefined || !/^\d{13}$/.test(issued ?? '') || !mac) {
    return 'INVALID';
  }
  const expected = createHmac('sha256', key)
    .update(`${tenantId}:${issued}`)
    .digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return 'INVALID';
  }
  const ageSeconds = (now.getTime() - Number(issued)) / 1000;
  if (ageSeconds < FORM_MIN_FILL_SECONDS) return 'TOO_FAST';
  if (ageSeconds > FORM_MAX_AGE_SECONDS) return 'EXPIRED';
  return 'OK';
}

/** El campo trampa lleno (un humano no lo ve ni lo rellena). */
export function honeypotTripped(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

/**
 * DX-016: comprobación anti-bots de un proveedor externo (captcha). PENDIENTE
 * la decisión del dueño sobre el proveedor: la implementación por defecto no
 * exige nada. Cambiarla es registrar otra clase para este símbolo.
 */
export const BOT_CHALLENGE_VERIFIER = Symbol('BOT_CHALLENGE_VERIFIER');

export interface BotChallengeVerifier {
  /** `true` si el desafío (si lo hay) se superó. */
  verify(input: { token: string | null; ip: string | null }): Promise<boolean>;
}

export class NoBotChallengeVerifier implements BotChallengeVerifier {
  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
