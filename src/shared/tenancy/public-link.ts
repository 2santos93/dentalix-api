/**
 * Enlaces públicos que la API arma hacia la web de una clínica (confirmación
 * de cita, DX-005; invitación de personal por email, DX-088; restablecer la
 * contraseña, DX-010; verificar el registro, DX-029).
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

/** Un solo label DNS: la forma de `tenants.subdomain` (ver host-parser). */
const SUBDOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Host para un enlace con un token que sirve para la cuenta GLOBAL o para una
 * membresía (restablecer la contraseña, DX-010; invitación de personal, que
 * puede reclamar una cuenta sin verificar, DX-088/DX-029). SEC-033: nunca el
 * dominio personalizado de la clínica —verificado solo por TXT, su A/CNAME lo
 * controla la clínica y podría recibir el token—, siempre un host cuyo DNS es
 * de Dentalix:
 * - si la petición ya llegó por un host de plataforma, ese mismo host (con su
 *   puerto, para el desarrollo con `<sub>.localhost:3000`);
 * - si no (dominio personalizado, host malformado o sin petición, p. ej. un
 *   trabajo en segundo plano), `<subdominio>.<TENANT_BASE_DOMAINS[0]>`, sin
 *   puerto.
 * `null` si no hay forma segura de armarlo: entonces no se envía el enlace.
 */
export function tenantLinkHost(
  requestHost: string | undefined,
  tenantSubdomain: string | null | undefined,
  baseDomains: readonly string[],
): string | null {
  const platform = platformLinkHost(requestHost, baseDomains);
  if (platform) return platform;
  const subdomain = tenantSubdomain?.trim().toLowerCase();
  const base = baseDomains[0];
  if (!subdomain || !SUBDOMAIN_LABEL.test(subdomain) || !base) return null;
  return safeLinkHost(`${subdomain}.${base}`);
}

/** `TENANT_BASE_DOMAINS` normalizado (mismo default que la resolución). */
export function parseBaseDomains(value: string | undefined): string[] {
  return (value ?? 'localhost')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
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
