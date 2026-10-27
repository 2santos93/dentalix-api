/**
 * Metadata de un evento de auditoría (DX-009). Lista CERRADA a propósito: un
 * evento dice QUIÉN tocó QUÉ y CUÁNDO, nunca el contenido. Ni texto de la
 * historia clínica, ni alergias, ni diagnósticos, ni firmas, ni importes: solo
 * nombres de campo, ids de la ruta y códigos.
 */
import { MAX_ALLOCATION_LINES } from '../../payments/domain/allocation-rules';

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
  status?: AuditStatusChange;
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
  /**
   * DX-233: horario de un profesional antes y después (semanal o una
   * excepción por fecha). Solo ids de sede, días, fechas y minutos: es
   * configuración de la agenda, sin datos de pacientes. Un lado vacío = no
   * había (o ya no hay) nada.
   */
  scheduleChange?: AuditScheduleChange;
  /**
   * DX-107: lote de importación de pacientes — SHA-256 del fichero, modo de
   * duplicados y totales (solo números). Ni el nombre del fichero ni filas.
   * DX-262: y su hoja de saldos — hash, contadores y el total por moneda
   * (importe AGREGADO del lote, pedido por el criterio de auditoría; nunca
   * el de un paciente ni su documento).
   */
  importBatch?: AuditImportBatch;
  /**
   * DX-273: al sacar una cita de COMPLETED, el mínimo de la visita siguiente
   * de cada plan afectado antes y después (día civil, o null = sin mínimo).
   * Solo ids, números y fechas: el motivo escrito va en
   * `appointment_status_reversals` (`params.reversalId`).
   */
  visitMinimums?: AuditVisitMinimum[];
  /**
   * DX-050: quién realizó un ítem del plan, en qué sede y cuándo, antes y
   * después de que un ADMIN lo corrija o de que el ítem salga de «Realizado».
   * Solo uuids e instantes ISO (null = sin atribuir).
   */
  attribution?: { before: AuditAttributionSide; after: AuditAttributionSide };
  /**
   * DX-279: una cita cancelada desde la agenda: quién (código), el código del
   * motivo, los minutos de aviso y si fue tardía. Nunca el texto libre del
   * motivo (va en la cita).
   */
  cancellation?: AuditCancellation;
  /**
   * DX-300: avisos de seguridad de una receta emitida: versión de las reglas,
   * CÓDIGOS de los bloqueantes y de los informativos, y si se confirmaron con
   * motivo. Nunca el texto del aviso (nombra fármacos de la anamnesis) ni el
   * del motivo: van sellados en la receta.
   */
  prescriptionSafety?: AuditPrescriptionSafety;
  /**
   * SEC-049: alta, cambio o verificación de una cobertura: el tipo de
   * pagador, los 4 últimos caracteres alfanuméricos del nº de afiliado (null
   * si no hay o es más corto) y si quedó verificada. Nunca el número entero.
   */
  coverage?: AuditCoverage;
  /**
   * DX-319: nº de registro sanitario de una sede y si sale en los documentos,
   * antes y después. Es la única excepción de texto: un dato público de la
   * SEDE (el que se imprime para el paciente), nunca de un paciente; hasta 64
   * caracteres sin saltos de línea ni caracteres de control.
   */
  healthRegistration?: AuditHealthRegistrationChange;
  /**
   * DX-051: reasignación de la imputación de un abono por un ADMIN: moneda
   * del plan, modo (MANUAL/AUTO) y las líneas (uuid del ítem e importe)
   * antes y después. Importes de la imputación pedidos por la spec (§8);
   * nada del paciente.
   */
  allocation?: AuditAllocation;
  /**
   * G1 (R13): moneda, zona y formato de una sede antes y después de una
   * edición, y si quedó revisada. Códigos de configuración de la sede (ISO
   * 4217, IANA, BCP 47); un lado puede traer null (sede sin configurar).
   * G1-B: y el reloj (`h12`/`h23`); los eventos de G1 no lo traen.
   */
  regionalSettings?: AuditRegionalSettingsChange;
}

export interface AuditRegionalSettingsSide {
  currency: string | null;
  timeZone: string | null;
  locale: string | null;
  /** G1-B; ausente en los eventos guardados antes de G1-B. */
  hourCycle?: 'h12' | 'h23' | null;
}

export interface AuditRegionalSettingsChange {
  before: AuditRegionalSettingsSide;
  after: AuditRegionalSettingsSide;
  reviewed: boolean;
}

/** Una línea de la imputación de un abono (DX-051). */
export interface AuditAllocationLine {
  itemId: string;
  amount: number;
}

export interface AuditAllocation {
  currency: string;
  mode: 'MANUAL' | 'AUTO';
  before: AuditAllocationLine[];
  after: AuditAllocationLine[];
}

export interface AuditCoverage {
  payerType: string;
  memberNumberLast4: string | null;
  verified: boolean;
}

/** Un lado del cambio del nº de registro sanitario de la sede (DX-319). */
export interface AuditHealthRegistrationSide {
  number: string | null;
  shown: boolean;
}

export interface AuditHealthRegistrationChange {
  before: AuditHealthRegistrationSide;
  after: AuditHealthRegistrationSide;
}

export interface AuditPrescriptionSafety {
  rulesVersion: string;
  blocking: string[];
  info: string[];
  overridden: boolean;
}

export const AUDIT_CANCELLATION_KINDS = [
  'PATIENT_LINK',
  'STAFF_FOR_PATIENT',
  'CLINIC',
] as const;

export const AUDIT_CANCELLATION_REASONS = [
  'ILLNESS',
  'FORGOT',
  'COST',
  'TRANSPORT',
  'WORK',
  'CLINIC_RESCHEDULE',
  'OTHER',
] as const;

/** Cancelación de una cita en la auditoría (DX-279): solo códigos y números. */
export interface AuditCancellation {
  byKind: (typeof AUDIT_CANCELLATION_KINDS)[number];
  reasonCode: (typeof AUDIT_CANCELLATION_REASONS)[number] | null;
  noticeMinutes: number;
  lateCancellation: boolean;
}

/** Un lado de la atribución de un ítem realizado (DX-050). */
export interface AuditAttributionSide {
  performedById: string | null;
  locationId: string | null;
  completedAt: string | null;
}

/** Mínimo de una visita del plan antes y después (DX-273). */
export interface AuditVisitMinimum {
  planId: string;
  visit: number;
  before: string | null;
  after: string | null;
}

export interface AuditImportBatch {
  fileSha256: string;
  mode?: 'SKIP' | 'FILL_EMPTY';
  rows?: number;
  valid?: number;
  duplicates?: number;
  errors?: number;
  created?: number;
  updated?: number;
  undoneCreated?: number;
  undoneFilled?: number;
  /** DX-262: hoja de saldos del lote. */
  balanceFileSha256?: string;
  balanceRows?: number;
  balanceErrors?: number;
  balancesCreated?: number;
  balancesUndone?: number;
  balanceTotals?: AuditCurrencyTotal[];
  /** Lo que retiró de verdad el deshacer, por moneda (revisión M5). */
  balanceUndoneTotals?: AuditCurrencyTotal[];
  /** «Añadir aunque ya tenga saldo migrado» marcado (QA D1). */
  balanceAddToExisting?: boolean;
  /** Saldos no creados porque el paciente ya tenía uno vivo (QA D1). */
  balancesExisting?: number;
}

/** Total por moneda de la hoja de saldos (DX-262): código, filas e importe. */
export interface AuditCurrencyTotal {
  currency: string;
  rows: number;
  amount: number;
}

/** Un tramo del horario de un profesional en la auditoría (DX-233). */
export interface AuditScheduleEntry {
  locationId: string;
  /** Tramo semanal: día 0–6. */
  weekday?: number;
  /** Excepción: fecha civil YYYY-MM-DD. */
  date?: string;
  startMinute?: number;
  endMinute?: number;
  /** Excepción «no trabaja» (sin tramos). */
  off?: true;
}

export interface AuditScheduleChange {
  before: AuditScheduleEntry[];
  after: AuditScheduleEntry[];
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
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Nº de registro sanitario (DX-319): 1–64 caracteres, sin control, formato ni
 * saltos (la misma clase que HEALTH_REGISTRATION_NUMBER_CHARS de locations).
 */
const HEALTH_REGISTRATION_NUMBER = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,64}$/u;
const MAX_FIELDS = 50;
/** Tope de tramos por lado (7 días × 7 tramos × varias sedes). */
const MAX_SCHEDULE_ENTRIES = 500;
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

const SHA256 = /^[0-9a-f]{64}$/;
const IMPORT_COUNTS = [
  'rows',
  'valid',
  'duplicates',
  'errors',
  'created',
  'updated',
  'undoneCreated',
  'undoneFilled',
  'balanceRows',
  'balanceErrors',
  'balancesCreated',
  'balancesUndone',
  'balancesExisting',
] as const;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MAX_CURRENCY_TOTALS = 20;

/** Totales por moneda con código ISO, filas enteras e importe a céntimos. */
function currencyTotals(value: unknown): AuditCurrencyTotal[] {
  if (!Array.isArray(value)) return [];
  const out: AuditCurrencyTotal[] = [];
  for (const item of value.slice(0, MAX_CURRENCY_TOTALS)) {
    if (!isRecord(item)) continue;
    const { currency, rows, amount } = item;
    if (
      typeof currency !== 'string' ||
      !CURRENCY_CODE.test(currency) ||
      typeof rows !== 'number' ||
      !Number.isInteger(rows) ||
      rows < 0 ||
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      Math.round(amount * 100) / 100 !== amount
    ) {
      continue;
    }
    out.push({ currency, rows, amount });
  }
  return out;
}

/** Hash con formato y contadores enteros ≥ 0 (el resto se descarta); sin hash, nada. */
function importBatch(value: unknown): AuditImportBatch | null {
  if (!isRecord(value)) return null;
  const { fileSha256, mode } = value;
  if (typeof fileSha256 !== 'string' || !SHA256.test(fileSha256)) return null;
  const out: AuditImportBatch = { fileSha256 };
  if (mode === 'SKIP' || mode === 'FILL_EMPTY') out.mode = mode;
  for (const key of IMPORT_COUNTS) {
    const n = value[key];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out[key] = n;
  }
  const { balanceFileSha256 } = value;
  if (typeof balanceFileSha256 === 'string' && SHA256.test(balanceFileSha256)) {
    out.balanceFileSha256 = balanceFileSha256;
  }
  const totals = currencyTotals(value.balanceTotals);
  if (totals.length > 0) out.balanceTotals = totals;
  const undone = currencyTotals(value.balanceUndoneTotals);
  if (undone.length > 0) out.balanceUndoneTotals = undone;
  if (typeof value.balanceAddToExisting === 'boolean') {
    out.balanceAddToExisting = value.balanceAddToExisting;
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

function minute(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1440
  );
}

/** Un tramo con la forma admitida, o `null`. */
function scheduleEntry(value: unknown): AuditScheduleEntry | null {
  if (!isRecord(value)) return null;
  const { locationId, weekday, date, startMinute, endMinute, off } = value;
  if (typeof locationId !== 'string' || !UUID.test(locationId)) return null;
  const out: AuditScheduleEntry = { locationId: locationId.toLowerCase() };
  if (weekday !== undefined) {
    if (
      typeof weekday !== 'number' ||
      !Number.isInteger(weekday) ||
      weekday < 0 ||
      weekday > 6
    ) {
      return null;
    }
    out.weekday = weekday;
  }
  if (date !== undefined) {
    if (typeof date !== 'string' || !CIVIL_DATE.test(date)) return null;
    out.date = date;
  }
  if ((out.weekday === undefined) === (out.date === undefined)) return null;
  if (off === true) {
    if (out.date === undefined) return null;
    out.off = true;
    return out;
  }
  if (!minute(startMinute) || !minute(endMinute)) return null;
  out.startMinute = startMinute;
  out.endMinute = endMinute;
  return out;
}

function scheduleSide(value: unknown): AuditScheduleEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCHEDULE_ENTRIES) {
    return null;
  }
  const entries = value.map(scheduleEntry);
  return entries.every((e): e is AuditScheduleEntry => e !== null)
    ? entries
    : null;
}

/** Los dos lados con la forma admitida, o nada. */
function scheduleChange(value: unknown): AuditScheduleChange | null {
  if (!isRecord(value)) return null;
  const before = scheduleSide(value.before);
  const after = scheduleSide(value.after);
  return before && after ? { before, after } : null;
}

const MAX_VISIT_MINIMUMS = 50;

function civilOrNull(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && CIVIL_DATE.test(value))
  );
}

/** Una entrada con exactamente esa forma, o `null`. */
function visitMinimum(value: unknown): AuditVisitMinimum | null {
  if (!isRecord(value)) return null;
  const { planId, visit, before, after, ...rest } = value;
  if (
    Object.keys(rest).length > 0 ||
    typeof planId !== 'string' ||
    !UUID.test(planId) ||
    typeof visit !== 'number' ||
    !Number.isInteger(visit) ||
    visit < 1 ||
    visit > 1000 ||
    !civilOrNull(before) ||
    !civilOrNull(after)
  ) {
    return null;
  }
  return { planId: planId.toLowerCase(), visit, before, after };
}

/** Las entradas válidas (hasta 50); el resto se descarta. */
function visitMinimums(value: unknown): AuditVisitMinimum[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(visitMinimum)
    .filter((v): v is AuditVisitMinimum => v !== null)
    .slice(0, MAX_VISIT_MINIMUMS);
}

function uuidOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID.test(value));
}

/** Un lado con exactamente esa forma, o `null`. */
function attributionSide(value: unknown): AuditAttributionSide | null {
  if (!isRecord(value)) return null;
  const { performedById, locationId, completedAt, ...rest } = value;
  if (
    Object.keys(rest).length > 0 ||
    !uuidOrNull(performedById) ||
    !uuidOrNull(locationId) ||
    !(
      completedAt === null ||
      (typeof completedAt === 'string' && ISO_INSTANT.test(completedAt))
    )
  ) {
    return null;
  }
  return {
    performedById: performedById?.toLowerCase() ?? null,
    locationId: locationId?.toLowerCase() ?? null,
    completedAt,
  };
}

/** Los dos lados con la forma admitida, o nada. */
function attribution(value: unknown): AuditMetadata['attribution'] | null {
  if (!isRecord(value)) return null;
  const before = attributionSide(value.before);
  const after = attributionSide(value.after);
  return before && after ? { before, after } : null;
}

function healthRegistrationSide(
  value: unknown,
): AuditHealthRegistrationSide | null {
  if (!isRecord(value)) return null;
  const { number, shown, ...rest } = value;
  if (
    Object.keys(rest).length > 0 ||
    typeof shown !== 'boolean' ||
    !(
      number === null ||
      (typeof number === 'string' && HEALTH_REGISTRATION_NUMBER.test(number))
    )
  ) {
    return null;
  }
  return { number, shown };
}

/** Los dos lados con la forma admitida, o nada (DX-319). */
function healthRegistration(
  value: unknown,
): AuditHealthRegistrationChange | null {
  if (!isRecord(value)) return null;
  const before = healthRegistrationSide(value.before);
  const after = healthRegistrationSide(value.after);
  return before && after ? { before, after } : null;
}

const TIME_ZONE_ID = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const AUDIT_HOUR_CYCLES = ['h12', 'h23'] as const;
const LOCALE_TAG = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;

function nullableCode(value: unknown, pattern: RegExp, max: number) {
  if (value === null) return null;
  if (typeof value === 'string' && value.length <= max && pattern.test(value)) {
    return value;
  }
  return undefined;
}

function regionalSettingsSide(
  value: unknown,
): AuditRegionalSettingsSide | null {
  if (!isRecord(value)) return null;
  const { currency, timeZone, locale, hourCycle, ...rest } = value;
  const c = nullableCode(currency, CURRENCY_CODE, 3);
  const z = nullableCode(timeZone, TIME_ZONE_ID, 64);
  const l = nullableCode(locale, LOCALE_TAG, 35);
  // G1-B: un evento de G1 no trae reloj y se sigue leyendo igual.
  const hasClock = 'hourCycle' in value;
  const h =
    hourCycle === null
      ? null
      : AUDIT_HOUR_CYCLES.find((cycle) => cycle === hourCycle);
  if (
    Object.keys(rest).length > 0 ||
    c === undefined ||
    z === undefined ||
    l === undefined ||
    (hasClock && h === undefined)
  ) {
    return null;
  }
  const side: AuditRegionalSettingsSide = {
    currency: c,
    timeZone: z,
    locale: l,
  };
  if (hasClock) side.hourCycle = h;
  return side;
}

/** Los dos lados y la marca de revisión, o nada (G1). */
function regionalSettings(value: unknown): AuditRegionalSettingsChange | null {
  if (!isRecord(value)) return null;
  const before = regionalSettingsSide(value.before);
  const after = regionalSettingsSide(value.after);
  if (!before || !after || typeof value.reviewed !== 'boolean') return null;
  return { before, after, reviewed: value.reviewed };
}

/** La cancelación entera con su forma, o nada (DX-279). */
function cancellation(value: unknown): AuditCancellation | null {
  if (!isRecord(value)) return null;
  const { byKind, reasonCode, noticeMinutes, lateCancellation, ...rest } =
    value;
  const kind = AUDIT_CANCELLATION_KINDS.find((k) => k === byKind);
  const reason =
    reasonCode === null
      ? null
      : AUDIT_CANCELLATION_REASONS.find((r) => r === reasonCode);
  if (
    Object.keys(rest).length > 0 ||
    !kind ||
    reason === undefined ||
    typeof noticeMinutes !== 'number' ||
    !Number.isInteger(noticeMinutes) ||
    noticeMinutes < 0 ||
    typeof lateCancellation !== 'boolean'
  ) {
    return null;
  }
  return { byKind: kind, reasonCode: reason, noticeMinutes, lateCancellation };
}

const MAX_SAFETY_CODES = 50;

function safetyCodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((c): c is string => typeof c === 'string' && CODE.test(c))
    .slice(0, MAX_SAFETY_CODES);
}

/** Versión, códigos y confirmación con su formato, o nada (DX-300). */
function prescriptionSafety(value: unknown): AuditPrescriptionSafety | null {
  if (!isRecord(value)) return null;
  const { rulesVersion, overridden } = value;
  const blocking = safetyCodes(value.blocking);
  const info = safetyCodes(value.info);
  if (
    typeof rulesVersion !== 'string' ||
    !CODE.test(rulesVersion) ||
    typeof overridden !== 'boolean' ||
    !blocking ||
    !info
  ) {
    return null;
  }
  return { rulesVersion, blocking, info, overridden };
}

/** Los 4 últimos del nº de afiliado: letras de cualquier alfabeto o dígitos. */
const LAST4 = /^[\p{L}0-9]{1,4}$/u;

/** Tipo de pagador con formato de código y verificación; el resto, fuera. */
function coverage(value: unknown): AuditCoverage | null {
  if (!isRecord(value)) return null;
  const { payerType, memberNumberLast4, verified } = value;
  if (
    typeof payerType !== 'string' ||
    !CODE.test(payerType) ||
    typeof verified !== 'boolean'
  ) {
    return null;
  }
  return {
    payerType,
    memberNumberLast4:
      typeof memberNumberLast4 === 'string' && LAST4.test(memberNumberLast4)
        ? memberNumberLast4
        : null,
    verified,
  };
}

/** Una línea con exactamente esa forma, o `null`. */
function allocationLine(value: unknown): AuditAllocationLine | null {
  if (!isRecord(value)) return null;
  const { itemId, amount, ...rest } = value;
  if (
    Object.keys(rest).length > 0 ||
    typeof itemId !== 'string' ||
    !UUID.test(itemId) ||
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    Math.round(amount * 100) / 100 !== amount
  ) {
    return null;
  }
  return { itemId: itemId.toLowerCase(), amount };
}

function allocationSide(value: unknown): AuditAllocationLine[] | null {
  if (!Array.isArray(value) || value.length > MAX_ALLOCATION_LINES) {
    return null;
  }
  const lines = value.map(allocationLine);
  return lines.every((l): l is AuditAllocationLine => l !== null)
    ? lines
    : null;
}

/** La reasignación entera con su forma, o nada (DX-051). */
function allocation(value: unknown): AuditAllocation | null {
  if (!isRecord(value)) return null;
  const { currency, mode, before: rawBefore, after: rawAfter, ...rest } = value;
  const before = allocationSide(rawBefore);
  const after = allocationSide(rawAfter);
  if (
    Object.keys(rest).length > 0 ||
    typeof currency !== 'string' ||
    !CURRENCY_CODE.test(currency) ||
    (mode !== 'MANUAL' && mode !== 'AUTO') ||
    !before ||
    !after
  ) {
    return null;
  }
  return { currency, mode, before, after };
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
  const schedule = scheduleChange(input.scheduleChange);
  if (schedule) out.scheduleChange = schedule;
  const batch = importBatch(input.importBatch);
  if (batch) out.importBatch = batch;
  const minimums = visitMinimums(input.visitMinimums);
  if (minimums.length > 0) out.visitMinimums = minimums;
  const attributed = attribution(input.attribution);
  if (attributed) out.attribution = attributed;
  const cancelled = cancellation(input.cancellation);
  if (cancelled) out.cancellation = cancelled;
  const safety = prescriptionSafety(input.prescriptionSafety);
  if (safety) out.prescriptionSafety = safety;
  const covered = coverage(input.coverage);
  if (covered) out.coverage = covered;
  const registration = healthRegistration(input.healthRegistration);
  if (registration) out.healthRegistration = registration;
  const reallocated = allocation(input.allocation);
  if (reallocated) out.allocation = reallocated;
  const regional = regionalSettings(input.regionalSettings);
  if (regional) out.regionalSettings = regional;
  return out;
}
