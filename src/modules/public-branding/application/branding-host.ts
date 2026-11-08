import { safeLinkHost } from '../../../shared/tenancy/public-link';

/** Un `Host` con puerto y punto final cabe de sobra; más es basura. */
const MAX_RAW_LENGTH = 260;
/** Nombre DNS: hasta 253 caracteres sin el punto final. */
const MAX_NAME_LENGTH = 253;
/** Una etiqueta DNS: 1–63 caracteres, sin guion en los extremos. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT = /^\d{1,5}$/;

/**
 * DX-517-ter: valida y normaliza el `host` que llega como DATO a
 * `GET /public/tenant/branding/by-host` ANTES de tocar la BD.
 *
 * Devuelve el nombre en minúsculas, sin puerto y sin un punto final (como lo
 * compara `parseHost`), o `null` si no es un `nombre[:puerto]` DNS válido:
 * pasa `SAFE_HOST` (`safeLinkHost`), cada etiqueta es DNS, el puerto es
 * 1–65535. Todo lo demás (credenciales `a@b`, rutas, `%00`, `a..b`, listas
 * por un `host` repetido, más de 260 caracteres) es `null`.
 */
export function normalizeBrandingHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_LENGTH) return null;
  const trimmed = raw.trim().toLowerCase();
  const parts = trimmed.split(':');
  if (parts.length > 2) return null;
  const [rawName, port] = parts;

  if (port !== undefined) {
    if (!PORT.test(port)) return null;
    const n = Number(port);
    if (n < 1 || n > 65535) return null;
  }

  const name = rawName.endsWith('.') ? rawName.slice(0, -1) : rawName;
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  if (!name.split('.').every((label) => LABEL.test(label))) return null;
  // Misma forma que los enlaces (`SAFE_HOST`): defensa en profundidad.
  if (!safeLinkHost(port === undefined ? name : `${name}:${port}`)) {
    return null;
  }
  return name;
}
