/** Un acceso de soporte (break-glass, SEC-008) tal como lo ve la clínica. */
export interface SupportAccess {
  id: string;
  userFullName: string;
  userEmail: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Posición en la lista (más reciente primero): instante + id de desempate. */
export interface SupportAccessCursor {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cursor opaco (base64url de `ISO|id`), mismo formato que el de auditoría. */
export function encodeSupportAccessCursor(cursor: SupportAccessCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString(
    'base64url',
  );
}

/** `null` si el cursor no es uno que haya emitido la API. */
export function decodeSupportAccessCursor(
  raw: string,
): SupportAccessCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const [iso, id, ...rest] = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .split('|');
  if (rest.length > 0 || !iso || !id || !UUID.test(id)) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) {
    return null;
  }
  return { createdAt, id: id.toLowerCase() };
}
