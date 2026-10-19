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
   * DX-200: cambio de estado de una cita en el flujo de la clínica (llegó, en
   * sillón, listo para cobrar, salida, «Deshacer llegada»): solo los códigos
   * del estado antes y después.
   */
  status?: { from: string; to: string };
  /**
   * DX-128: de dónde salió un cambio de canal, de opt-in de WhatsApp o una
   * baja de recordatorios: en persona, enlace, mensaje del paciente, o
   * anotado por el personal. DX-150: `JOB` = lo hizo un trabajo programado
   * (el barrido de cobranza que cierra compromisos de pago), sin usuario.
   */
  origin?: AuditOrigin;
  /**
   * DX-191: búsqueda «¿quién recibió este lote / esta referencia?» de
   * implantes (y su CSV): el lote y la REF buscados (códigos de producto del
   * fabricante, no datos del paciente) y cuántas filas salieron.
   */
  search?: AuditSearch;
  /**
   * DX-215: cambio de estado de un recurso que no lo dice el `reason` solo
   * (un compromiso de pago CUMPLIDO que vuelve a ABIERTO o pasa a INCUMPLIDO al
   * anular su abono). Solo códigos de estado.
   */
  statusChange?: AuditStatusChange;
}

/** Estado antes y después (códigos), DX-215. */
export interface AuditStatusChange {
  from: string;
  to: string;
}

/** Lo buscado en una búsqueda auditada por lote/REF (DX-191). */
export interface AuditSearch {
  lot?: string;
  reference?: string;
  rows: number;
}

export const AUDIT_ORIGINS = [
  'IN_PERSON',
  'LINK',
  'MESSAGE',
  'STAFF',
  'JOB',
] as const;
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
/** Lote o REF de un producto sanitario: alfanumérico con . _ - / y espacios. */
const PRODUCT_CODE = /^[A-Za-z0-9][A-Za-z0-9 ._\-/]{0,79}$/;
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

/** Los dos códigos de estado, o nada. */
function statusChange(value: unknown): AuditMetadata['status'] | null {
  if (!isRecord(value)) return null;
  const { from, to } = value;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !CODE.test(from) ||
    !CODE.test(to)
  ) {
    return null;
  }
  return { from, to };
}

/** Lote/REF con formato de código y nº de filas; si no, nada. */
function search(value: unknown): AuditSearch | null {
  if (!isRecord(value)) return null;
  const { lot, reference, rows } = value;
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 0) {
    return null;
  }
  const out: AuditSearch = { rows };
  if (typeof lot === 'string' && PRODUCT_CODE.test(lot)) out.lot = lot;
  if (typeof reference === 'string' && PRODUCT_CODE.test(reference)) {
    out.reference = reference;
  }
  return out;
}

/** Los dos estados con formato de código, o nada. */
function statusChange(value: unknown): AuditStatusChange | null {
  if (!isRecord(value)) return null;
  const { from, to } = value;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !CODE.test(from) ||
    !CODE.test(to)
  ) {
    return null;
  }
  return { from, to };
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
  const status = statusChange(input.status);
  if (status) out.status = status;
  const origin = AUDIT_ORIGINS.find((o) => o === input.origin);
  if (origin) out.origin = origin;
  const searched = search(input.search);
  if (searched) out.search = searched;
  const change = statusChange(input.statusChange);
  if (change) out.statusChange = change;
  return out;
}
