/**
 * Extrae `<namespace>/<filename>` (los dos últimos segmentos del path) de una
 * URL de archivo como `http://.../api/v1/files/avatars/u1.png`. Devuelve null
 * si la URL es inválida. Permite borrar el archivo previo sin guardar la key
 * aparte en BD.
 */
export function splitFileUrl(
  url: string,
): { namespace: string; filename: string } | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return {
      namespace: segments[segments.length - 2],
      filename: segments[segments.length - 1],
    };
  } catch {
    return null;
  }
}
