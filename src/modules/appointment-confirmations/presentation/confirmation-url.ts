/** Ruta pública de la web (src/app/(public)/confirmar/[token]). */
export const CONFIRMATION_PATH = '/confirmar';

/**
 * Host válido para el enlace: nombre DNS + puerto numérico opcional, y nada
 * más. Hace falta porque la resolución del tenant (`parseHost`) descarta todo
 * lo que va tras el primer `:`: un `Host`/`X-Forwarded-Host` como
 * `demo.dentalix.app:443@evil.com` resuelve a la clínica "demo" y, copiado tal
 * cual, armaría `https://demo.dentalix.app:443@evil.com/confirmar/<token>`,
 * que el navegador abre en evil.com (con el token del paciente).
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
 * URL pública del enlace. El host es el de la clínica con el que llegó la
 * petición autenticada (ya resuelto y cruzado con el JWT por
 * TenantContextInterceptor, y validado con `safeLinkHost`), así que el enlace
 * vive en su subdominio o en su dominio propio, igual que la web que lo pidió.
 */
export function buildConfirmationUrl(
  protocol: 'http' | 'https',
  safeHost: string,
  token: string,
): string {
  return `${protocol}://${safeHost}${CONFIRMATION_PATH}/${token}`;
}
