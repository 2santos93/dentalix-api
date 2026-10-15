/** Ruta pública de la web (src/app/(public)/confirmar/[token]). */
export const CONFIRMATION_PATH = '/confirmar';

/**
 * URL pública del enlace. El host es el de la clínica con el que llegó la
 * petición autenticada (ya resuelto y cruzado con el JWT por
 * TenantContextInterceptor), así que el enlace vive en su subdominio o en su
 * dominio propio, igual que la web que lo pidió.
 */
export function buildConfirmationUrl(
  protocol: 'http' | 'https',
  host: string,
  token: string,
): string {
  return `${protocol}://${host.toLowerCase()}${CONFIRMATION_PATH}/${token}`;
}
