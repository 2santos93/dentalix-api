/** Posición en la lista (más reciente primero): instante + id de desempate. */
export interface AuditCursor {
  occurredAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cursor opaco (base64url de `ISO|id`). El orden es `occurredAt DESC, id DESC`:
 * el id desempata los eventos del mismo milisegundo, así una página nunca
 * repite ni se salta filas aunque entren eventos nuevos mientras se pagina.
 */
export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(
    `${cursor.occurredAt.toISOString()}|${cursor.id}`,
  ).toString('base64url');
}

/** `null` si el cursor no es uno que haya emitido la API. */
export function decodeAuditCursor(raw: string): AuditCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const [iso, id, ...rest] = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .split('|');
  if (rest.length > 0 || !iso || !id || !UUID.test(id)) return null;
  const occurredAt = new Date(iso);
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== iso) {
    return null;
  }
  return { occurredAt, id: id.toLowerCase() };
}
