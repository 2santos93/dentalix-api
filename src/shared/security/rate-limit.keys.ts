import { createHash } from 'crypto';

// Las claves se hashean para no guardar emails ni tokens en claro en el
// almacenamiento del limitador. `prefix` identifica ruta + política, así que
// cada ruta tiene su propio balde.
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

// Claims del JWT de la cabecera, DECODIFICADOS SIN VERIFICAR: el limitador
// corre antes de JwtAuthGuard. Falsearlos no da nada: con un token inválido la
// petición acaba en 401 sin llegar a la acción.
function unverifiedClaims(authorization: string): {
  sub: string | null;
  tenantId: string | null;
} {
  const token = authorization.replace(/^Bearer\s+/i, '');
  const payload = token.split('.')[1];
  if (!payload) return { sub: null, tenantId: null };
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { sub?: unknown; tenantId?: unknown } | null;
    const pick = (v: unknown): string | null =>
      typeof v === 'string' && v !== '' ? v : null;
    return { sub: pick(decoded?.sub), tenantId: pick(decoded?.tenantId) };
  } catch {
    return { sub: null, tenantId: null };
  }
}

function unverifiedSubject(authorization: string): string | null {
  return unverifiedClaims(authorization).sub;
}

/**
 * Balde `invitation-email` (DX-088): clínica + usuario del token, SIN IP: el
 * límite es de quien manda los emails, salga por la IP que salga. Sin token
 * decodificable cae en la cabecera completa (acabará en 401 igualmente).
 */
export function staffActorRateLimitKey(
  prefix: string,
  authorization: unknown,
): string {
  const header = typeof authorization === 'string' ? authorization : '';
  const { sub, tenantId } = header
    ? unverifiedClaims(header)
    : { sub: null, tenantId: null };
  const who =
    sub && tenantId
      ? `actor:${sha256(`${tenantId}:${sub}`)}`
      : `hdr:${sha256(header)}`;
  return sha256(`${prefix}-${who}`);
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

/**
 * Balde `anamnesis-token` (DX-099): por el TOKEN de la ruta pública, sin IP.
 * La clave guarda el hash, nunca el token en claro.
 */
export function publicTokenRateLimitKey(
  prefix: string,
  token: unknown,
): string {
  const value = typeof token === 'string' ? token : '';
  return sha256(`${prefix}-token:${sha256(value)}`);
}

/**
 * Balde `branding-host` (DX-555): IP + host YA NORMALIZADO (minúsculas, sin
 * puerto ni punto final; `normalizeBrandingHost`), así `Clinica.Example:443`
 * y `clinica.example` comparten balde. Un host mal formado (`null`) cae en un
 * único balde «inválido» por IP: no abre una clave nueva por cada basura. La
 * clave guarda hashes, nunca el host en claro.
 */
export function brandingHostRateLimitKey(
  prefix: string,
  ip: string,
  normalizedHost: string | null,
): string {
  const host =
    normalizedHost === null ? 'invalid' : `name:${sha256(normalizedHost)}`;
  return sha256(`${prefix}-${ip}-host:${host}`);
}

/**
 * Balde `branding-miss` (DX-555): los FALLOS de la marca por host, por IP.
 * Lo usa `BrandingMissLimitInterceptor` (no el guard): un fallo solo se sabe
 * tras la consulta.
 */
export function brandingMissRateLimitKey(prefix: string, ip: string): string {
  return sha256(`${prefix}-miss:${ip}`);
}
