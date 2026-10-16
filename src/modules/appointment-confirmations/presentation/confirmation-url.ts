/** Ruta pública de la web (src/app/(public)/confirmar/[token]). */
export const CONFIRMATION_PATH = '/confirmar';

// El host se valida con `safeLinkHost` (compartido con las invitaciones por
// email, DX-088); se reexporta para los consumidores de siempre.
export { safeLinkHost } from '../../../shared/tenancy/public-link';

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
