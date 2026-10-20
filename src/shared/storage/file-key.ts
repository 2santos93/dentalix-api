/**
 * DX-084: en la BD se guarda la CLAVE del fichero (`avatars/<userId>.png`),
 * nunca la URL absoluta. La URL pública se calcula al responder con la
 * `FILES_PUBLIC_BASE_URL` vigente, así que cambiar de dominio no rompe nada.
 *
 * Una clave son segmentos en minúscula separados por `/` (el primero es el
 * espacio: `avatars`, …) y un nombre final; sin `..`, sin barras al borde y
 * sin PII (la arma el código con ids, no con nombres del usuario).
 */
const SEGMENT = '[a-z0-9][a-z0-9-]*';
const NAME = '[A-Za-z0-9_-][A-Za-z0-9._-]*';
const KEY_PATTERN = new RegExp(`^(?:${SEGMENT}/)+${NAME}$`);

export function isFileKey(key: string): boolean {
  return (
    KEY_PATTERN.test(key) &&
    !key.split('/').some((s) => s === '.' || s === '..' || s.includes('..'))
  );
}

export function assertFileKey(key: string): void {
  if (!isFileKey(key)) {
    throw new Error(`Clave de fichero inválida: "${key}"`);
  }
}

/** `${base}/${key}`, sin barras dobles aunque la base termine en `/`. */
export function publicFileUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key}`;
}

/**
 * Normaliza lo que haya en una columna de fichero: una clave se devuelve tal
 * cual y una URL absoluta de antes de DX-084 (`…/files/avatars/u1.png`) pasa
 * a su clave (los dos últimos segmentos del path). Cubre las filas que una
 * réplica antigua escriba durante un despliegue escalonado, después de la
 * migración. Devuelve null si no se reconoce.
 */
export function legacyUrlToKey(value: string): string | null {
  if (isFileKey(value)) return value;
  let segments: string[];
  try {
    segments = new URL(value).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (segments.length < 2) return null;
  const key = segments.slice(-2).join('/');
  return isFileKey(key) ? key : null;
}
