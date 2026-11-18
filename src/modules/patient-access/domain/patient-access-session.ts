import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * DX-101: sesión del navegador del paciente tras verificar la fecha de
 * nacimiento. Va en su PROPIA cookie (`dentalix_pa`), distinta de la del
 * personal, y solo sirve para las rutas `public/patient-access/me…`.
 *
 * Valor: `v1.<linkId>.<expMs>.<nonce>.<hmac>`, con HMAC-SHA256 sobre la
 * clínica, el enlace, la caducidad y el nonce (clave derivada con HKDF del
 * secreto de la API, con su propio `info`: no sirve para nada más). No lleva
 * ni el paciente ni los apartados: cada petición relee el enlace bajo RLS, así
 * que revocarlo corta la sesión en la siguiente petición y una cookie de otra
 * clínica no encuentra nada.
 */

export const PATIENT_ACCESS_COOKIE = 'dentalix_pa';
/** La cookie solo viaja a las rutas del portal del paciente de la API. */
export const PATIENT_ACCESS_COOKIE_PATH = '/api/v1/public/patient-access';

const VERSION = 'v1';
const HKDF_SALT = 'dentalix:patient-access';
const HKDF_INFO = 'dx101-session-cookie-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const HMAC_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const EXP = /^\d{1,15}$/;
/** Tope de la cabecera que se intenta leer (una cookie absurda no se procesa). */
const MAX_VALUE_LENGTH = 200;

export function derivePatientAccessSessionKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, 32));
}

function mac(
  key: Buffer,
  tenantId: string,
  linkId: string,
  exp: string,
  nonce: string,
): Buffer {
  return createHmac('sha256', key)
    .update(`${VERSION}|${tenantId}|${linkId}|${exp}|${nonce}`)
    .digest();
}

export interface PatientAccessSessionClaims {
  linkId: string;
  expiresAt: Date;
}

export function signPatientAccessSession(
  key: Buffer,
  tenantId: string,
  linkId: string,
  expiresAt: Date,
): string {
  const exp = String(expiresAt.getTime());
  const nonce = randomBytes(16).toString('base64url');
  const sig = mac(key, tenantId, linkId, exp, nonce).toString('base64url');
  return `${VERSION}.${linkId}.${exp}.${nonce}.${sig}`;
}

/**
 * La sesión si la firma es de esta clínica (tiempo constante) y no caducó;
 * si no, `null` (el guard responde 401 sin decir por qué).
 */
export function verifyPatientAccessSession(
  key: Buffer,
  tenantId: string,
  value: string | undefined,
  now: Date,
): PatientAccessSessionClaims | null {
  if (!value || value.length > MAX_VALUE_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 5) return null;
  const [version, linkId, exp, nonce, sig] = parts;
  if (
    version !== VERSION ||
    !UUID.test(linkId) ||
    !EXP.test(exp) ||
    !NONCE.test(nonce) ||
    !HMAC_SHAPE.test(sig)
  ) {
    return null;
  }
  const expected = mac(key, tenantId, linkId, exp, nonce);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  const expiresAt = new Date(Number(exp));
  if (expiresAt.getTime() <= now.getTime()) return null;
  return { linkId, expiresAt };
}

/** El valor de una cookie de la cabecera `Cookie`, o `undefined`. */
export function readCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}
