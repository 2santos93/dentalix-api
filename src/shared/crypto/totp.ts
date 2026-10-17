import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238 sobre HOTP, RFC 4226) con HMAC-SHA1, pasos de 30 s y 6
 * dígitos: lo que entienden Google Authenticator, 1Password, Authy, etc.
 * Implementación propia de ~50 líneas sobre `node:crypto` en vez de una
 * dependencia más en la ruta del login; la fijan los vectores del RFC en
 * totp.spec.ts.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Pasos de holgura a cada lado (reloj del móvil desfasado): ±30 s. */
export const TOTP_WINDOW = 1;
/** 160 bits: el tamaño de clave que recomienda el RFC 4226 para SHA-1. */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) sin relleno, como lo esperan las apps de autenticación. */
export function encodeBase32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Inversa de `encodeBase32`; ignora espacios, guiones y `=`. Lanza si no es base32. */
export function decodeBase32(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('base32 inválido');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Paso TOTP (contador) de un instante en ms. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP truncado (RFC 4226 §5.3) para un contador. */
export function totpCode(
  secret: Buffer,
  step: number,
  digits: number = TOTP_DIGITS,
  algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac(algorithm, secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Busca `code` en la ventana [paso actual − TOTP_WINDOW, + TOTP_WINDOW] y
 * devuelve el paso que casa, o `null`. Solo acepta pasos POSTERIORES a
 * `lastUsedStep`: un código ya usado (o uno anterior a él) no vale dos veces
 * (anti-replay, RFC 6238 §5.2). Quien llama debe persistir el paso devuelto
 * de forma atómica.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  // Se recorren todos los pasos (sin cortar al primero) para no dar pistas
  // por tiempo de cuál casó.
  for (
    let step = current - TOTP_WINDOW;
    step <= current + TOTP_WINDOW;
    step++
  ) {
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (lastUsedStep !== null && matched <= lastUsedStep) return null;
  return matched;
}

/** Secreto nuevo en base32 (32 caracteres). */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(SECRET_BYTES));
}

/**
 * URI `otpauth://` (formato de Google Authenticator) para el QR o para pegar
 * a mano. La etiqueta es `Emisor:cuenta`, ambas codificadas.
 */
export function totpUri(
  secretBase32: string,
  account: string,
  issuer: string,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = [
    `secret=${secretBase32}`,
    `issuer=${encodeURIComponent(issuer)}`,
    'algorithm=SHA1',
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
