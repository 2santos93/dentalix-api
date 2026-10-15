import { createHash } from 'crypto';

// Las claves se hashean para no guardar emails ni tokens en claro en el
// almacenamiento del limitador. `prefix` identifica ruta + política, así que
// cada ruta tiene su propio balde.
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function normalizedEmail(body: unknown): string {
  return typeof body === 'object' &&
    body !== null &&
    typeof (body as { email?: unknown }).email === 'string'
    ? (body as { email: string }).email.trim().toLowerCase()
    : '';
}

/**
 * Balde `login`: IP + email. Corta la fuerza bruta contra una cuenta sin
 * bloquear a los compañeros de la clínica que salen por la misma IP (NAT). El
 * "spraying" de muchos emails desde una IP lo frena el balde `auth` (solo IP).
 */
export function loginRateLimitKey(
  prefix: string,
  ip: string,
  body: unknown,
): string {
  return sha256(`${prefix}-${ip}-${normalizedEmail(body)}`);
}

/**
 * Balde `login-account`: solo el email, sin IP. Frena la fuerza bruta
 * DISTRIBUIDA (muchas IPs contra la misma cuenta), que esquiva los baldes por
 * IP. Es holgado porque cualquiera puede consumirlo para un email ajeno.
 */
export function loginAccountRateLimitKey(
  prefix: string,
  body: unknown,
): string {
  return sha256(`${prefix}-account-${normalizedEmail(body)}`);
}

// `sub` del JWT de la cabecera, DECODIFICADO SIN VERIFICAR: el limitador corre
// antes de JwtAuthGuard. Falsearlo no da nada: con un token inválido la
// petición acaba en 401 sin llegar a comprobar la contraseña.
function unverifiedSubject(authorization: string): string | null {
  const token = authorization.replace(/^Bearer\s+/i, '');
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const sub = (decoded as { sub?: unknown } | null)?.sub;
    return typeof sub === 'string' && sub !== '' ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Balde `password` (POST /me/password): IP + usuario. Así una IP NAT
 * compartida no bloquea a toda la clínica cuando uno se equivoca. Usa el `sub`
 * del token (el mismo usuario con un token renovado comparte balde) y, si no
 * se puede decodificar, la cabecera completa.
 */
export function passwordRateLimitKey(
  prefix: string,
  ip: string,
  authorization: unknown,
): string {
  const header = typeof authorization === 'string' ? authorization : '';
  const sub = header ? unverifiedSubject(header) : null;
  const who = sub
    ? `sub:${sha256(sub)}`
    : header
      ? `hdr:${sha256(header)}`
      : '';
  return sha256(`${prefix}-${ip}-${who}`);
}
