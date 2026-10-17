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
  /**
   * DX-121: cita movida — hora y profesional antes y después. Solo instantes
   * ISO y uuids: ni paciente, ni motivo, ni notas.
   */
  move?: { from: AuditAppointmentSlot; to: AuditAppointmentSlot };
  /**
   * DX-128: de dónde salió un cambio de canal, de opt-in de WhatsApp o una
   * baja de recordatorios: en persona, enlace, mensaje del paciente, o
   * anotado por el personal.
   */
  origin?: AuditOrigin;
}

export const AUDIT_ORIGINS = ['IN_PERSON', 'LINK', 'MESSAGE', 'STAFF'] as const;
export type AuditOrigin = (typeof AUDIT_ORIGINS)[number];

/** Hueco de una cita en un movimiento auditado (DX-121). */
export interface AuditAppointmentSlot {
  start: string;
  end: string;
  providerId: string;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_NUMBER = /^\d{1,6}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Instante ISO 8601 en UTC tal como lo emite `Date.toISOString()`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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

function appointmentSlot(value: unknown): AuditAppointmentSlot | null {
  if (!isRecord(value)) return null;
  const { start, end, providerId } = value;
  if (
    typeof start !== 'string' ||
    typeof end !== 'string' ||
    typeof providerId !== 'string' ||
    !ISO_INSTANT.test(start) ||
    !ISO_INSTANT.test(end) ||
    !UUID.test(providerId)
  ) {
    return null;
  }
  return { start, end, providerId: providerId.toLowerCase() };
}

/** El movimiento entero, o nada: medio movimiento no le sirve a nadie. */
function appointmentMove(value: unknown): AuditMetadata['move'] | null {
  if (!isRecord(value)) return null;
  const from = appointmentSlot(value.from);
  const to = appointmentSlot(value.to);
  return from && to ? { from, to } : null;
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
  const move = appointmentMove(input.move);
  if (move) out.move = move;
  const origin = AUDIT_ORIGINS.find((o) => o === input.origin);
  if (origin) out.origin = origin;
  return out;
}
