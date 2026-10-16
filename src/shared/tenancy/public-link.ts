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
