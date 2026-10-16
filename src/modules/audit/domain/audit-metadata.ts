/**
 * Metadata de un evento de auditoría (DX-009). Lista CERRADA a propósito: un
 * evento dice QUIÉN tocó QUÉ y CUÁNDO, nunca el contenido. Ni texto de la
 * historia clínica, ni alergias, ni diagnósticos, ni firmas, ni importes: solo
 * nombres de campo, ids de la ruta y códigos.
 */
export interface AuditMetadata {
  /** Campos que traía la petición de escritura (nombres, nunca valores). */
  changedFields?: string[];
  /** Parámetros de la ruta: UUIDs o números cortos (p. ej. el diente FDI). */
  params?: Record<string, string>;
  /** Código de resultado, p. ej. `INVALID_CREDENTIALS` en un login fallido. */
  reason?: string;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_NUMBER = /^\d{1,6}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_FIELDS = 50;
const MAX_PARAMS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.filter(
    (v): v is string => typeof v === 'string' && IDENTIFIER.test(v),
  );
  return [...new Set(names)].sort().slice(0, MAX_FIELDS);
}

function routeParams(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_PARAMS) break;
    if (!IDENTIFIER.test(key) || typeof raw !== 'string') continue;
    if (UUID.test(raw) || SHORT_NUMBER.test(raw)) out[key] = raw.toLowerCase();
  }
  return out;
}

/**
 * Deja pasar solo lo que la lista admite, con el formato que admite. Lo que
 * no encaja se DESCARTA (no se trunca ni se escapa): así un valor clínico que
 * llegara por error a cualquier clave nunca acaba en la tabla.
 */
export function sanitizeAuditMetadata(input: unknown): AuditMetadata {
  if (!isRecord(input)) return {};
  const out: AuditMetadata = {};
  const changedFields = fieldNames(input.changedFields);
  if (changedFields.length > 0) out.changedFields = changedFields;
  const params = routeParams(input.params);
  if (Object.keys(params).length > 0) out.params = params;
  if (typeof input.reason === 'string' && CODE.test(input.reason)) {
    out.reason = input.reason;
  }
  return out;
}
