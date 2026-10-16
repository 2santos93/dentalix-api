/**
 * Enlaces públicos que la API arma hacia la web de una clínica (confirmación
 * de cita, DX-005; invitación de personal por email, DX-088).
 */

/**
 * Host válido para el enlace: nombre DNS + puerto numérico opcional, y nada
 * más. Hace falta porque la resolución del tenant (`parseHost`) descarta todo
 * lo que va tras el primer `:`: un `Host`/`X-Forwarded-Host` como
 * `demo.dentalix.app:443@evil.com` resuelve a la clínica "demo" y, copiado tal
 * cual, armaría `https://demo.dentalix.app:443@evil.com/...`, que el navegador
 * abre en evil.com (con el token dentro).
 */
const SAFE_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;

/**
 * Host normalizado (minúsculas) para el enlace, o `null` si trae algo que no
 * sea `nombre[:puerto]` (ver SAFE_HOST).
 */
export function safeLinkHost(host: string | undefined): string | null {
  const normalized = host?.trim().toLowerCase();
  return normalized && SAFE_HOST.test(normalized) ? normalized : null;
}

/**
 * Host de la PLATAFORMA para un enlace que no pertenece a ninguna clínica (el
 * de verificar el registro, DX-029): el dominio raíz o uno de sus subdominios
 * (`TENANT_BASE_DOMAINS`, DNS de Dentalix). Cualquier otro host —un `Host` /
 * `X-Forwarded-Host` inyectado o el dominio personalizado de una clínica, cuyo
 * DNS controla un tercero— devuelve `null`: si no, el enlace con el token iría
 * a un servidor ajeno y su dueño podría confirmar el registro (y quedarse con
 * el email) en lugar de la persona.
 */
export function platformLinkHost(
  host: string | undefined,
  baseDomains: readonly string[],
): string | null {
  const safe = safeLinkHost(host);
  if (!safe) return null;
  const hostname = safe.split(':')[0];
  const isPlatform = baseDomains.some(
    (base) => hostname === base || hostname.endsWith(`.${base}`),
  );
  return isPlatform ? safe : null;
}

export type PublicWebProtocol = 'http' | 'https';

/**
 * Protocolo de los enlaces públicos: `PUBLIC_WEB_PROTOCOL` si es válido; si
 * no, https en producción y http en el resto.
 */
export function resolvePublicWebProtocol(
  get: (key: string) => string | undefined,
): PublicWebProtocol {
  const configured = get('PUBLIC_WEB_PROTOCOL');
  if (configured === 'http' || configured === 'https') {
    return configured;
  }
  return get('NODE_ENV') === 'production' ? 'https' : 'http';
}
