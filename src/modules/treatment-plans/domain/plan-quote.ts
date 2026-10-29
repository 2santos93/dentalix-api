import { createHash } from 'node:crypto';
import { ToothSurface } from '@prisma/client';

/** «Válido 30 días»: el presupuesto caduca 30 días naturales después de emitirse. */
export const QUOTE_VALIDITY_DAYS = 30;

const QUOTE_HASH_VERSION = 'dentalix-plan-quote-v1';
/** DX-105: el hash v2 sella además el convenio, el precio de lista y el ahorro. */
export const QUOTE_HASH_VERSION_V2 = 'dentalix-plan-quote-v2';
/** Separador de los nombres cuando un plan mezcla varios convenios. */
const AGREEMENT_NAMES_SEPARATOR = ' · ';
const ACCEPTANCE_HASH_VERSION = 'dentalix-plan-acceptance-v1';

/** Lo que hace falta para componer el presupuesto de un plan. */
export interface QuoteContentSource {
  planId: string;
  patientId: string;
  currency: string;
  clinicName: string;
  location: QuoteLocation;
  patient: QuotePatient;
  professionalName: string | null;
  /** Ítems vivos del plan, en el orden en que se presentan. */
  items: QuoteSourceItem[];
}

export interface QuoteSourceItem {
  id: string;
  toothNumber: string;
  surfaces: ToothSurface[];
  procedure: string;
  price: number;
  discount: number;
  /** Precio de catálogo congelado en el ítem (`basePrice`); `null` en ítems anteriores a DX-105. */
  basePrice: number | null;
  /** Precio de referencia resuelto (`catalogPrice`); `null` en ítems anteriores a DX-105. */
  referencePrice: number | null;
  /** Nombre del convenio con que se fijó el precio; `null` si no lo hubo. */
  agreementName: string | null;
  /** Pagador de ese convenio; `null` si no hubo convenio. */
  agreementPayerName: string | null;
}

export interface QuoteLocation {
  id: string;
  name: string;
  address: string | null;
}

export interface QuotePatient {
  name: string;
  /**
   * `documentText` del nombre visible y el número (DX-327, R8), o `null` si
   * el paciente no tiene documento. Lo aceptado conserva el texto que firmó.
   */
  document: string | null;
}

/**
 * Una línea del presupuesto. Un ítem del plan es UN procedimiento sobre UN
 * diente, así que la cantidad es siempre 1; se imprime igualmente porque es lo
 * que el paciente compara con otros presupuestos.
 */
export interface QuoteItem {
  id: string;
  toothNumber: string;
  surfaces: ToothSurface[];
  procedure: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  subtotal: number;
  /** Precio de catálogo (v2); `null` si el ítem no lo guardó. */
  listPrice: number | null;
  /** Convenio con que se fijó el precio (v2). */
  agreementName: string | null;
}

export interface QuoteTotal {
  currency: string;
  gross: number;
  discount: number;
  net: number;
  /** Σ max(0, precio de lista − precio de referencia) de los ítems con convenio (v2). */
  agreementSaving: number;
}

/** El convenio del presupuesto: el del primer ítem que lo tiene. */
export interface QuoteAgreement {
  name: string;
  payerName: string;
}

/**
 * El presupuesto tal como se presenta (y, si se acepta, tal como se firma y se
 * guarda): todo lo que el hash sella. No incluye el logo (es marca, no
 * contenido) ni el estado del plan.
 */
export interface QuoteContent {
  /**
   * 2 = presupuesto con convenio y ahorro (DX-105), el único que se compone
   * hoy. 1 = fotos firmadas antes de DX-105: se leen con `agreement: null`,
   * `listPrice`/`agreementName` nulos y ahorro 0, y su hash sigue siendo el v1.
   */
  version: 1 | 2;
  planId: string;
  patientId: string;
  currency: string;
  clinicName: string;
  location: QuoteLocation;
  patient: QuotePatient;
  professionalName: string | null;
  /** Convenio aplicado a los ítems; `null` si ninguno lo tiene. */
  agreement: QuoteAgreement | null;
  /** `YYYY-MM-DD` en la zona de la sede. */
  issuedOn: string;
  validUntil: string;
  validityDays: number;
  items: QuoteItem[];
  /** Una fila por moneda (hoy un plan tiene una sola). */
  totals: QuoteTotal[];
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * El convenio del presupuesto: el del primer ítem que lo tiene. Si hay varios
 * convenios distintos, el nombre junta todos (en orden de aparición) y el
 * pagador es el del primero.
 */
function agreementOf(items: QuoteSourceItem[]): QuoteAgreement | null {
  const withAgreement = items.filter(
    (i): i is QuoteSourceItem & { agreementName: string } =>
      i.agreementName !== null,
  );
  if (withAgreement.length === 0) return null;
  const names = [...new Set(withAgreement.map((i) => i.agreementName))];
  return {
    name: names.join(AGREEMENT_NAMES_SEPARATOR),
    payerName: withAgreement[0].agreementPayerName ?? '',
  };
}

/**
 * Compone el presupuesto. El dinero se suma en céntimos enteros, así que el
 * total nunca arrastra deriva de coma flotante; un plan sin ítems da totales
 * en cero.
 */
export function buildQuoteContent(
  source: QuoteContentSource,
  issuedOn: string,
): QuoteContent {
  const items: QuoteItem[] = source.items.map((item) => ({
    id: item.id,
    toothNumber: item.toothNumber,
    surfaces: [...item.surfaces],
    procedure: item.procedure,
    quantity: 1,
    unitPrice: item.price,
    discount: item.discount,
    subtotal: fromCents(toCents(item.price) - toCents(item.discount)),
    listPrice: item.basePrice,
    agreementName: item.agreementName,
  }));
  const gross = items.reduce((sum, i) => sum + toCents(i.unitPrice), 0);
  const discount = items.reduce((sum, i) => sum + toCents(i.discount), 0);
  const saving = source.items.reduce(
    (sum, i) =>
      i.agreementName !== null &&
      i.basePrice !== null &&
      i.referencePrice !== null
        ? sum +
          Math.max(
            0,
            toCents(i.basePrice) -
              Math.max(toCents(i.price), toCents(i.referencePrice)),
          )
        : sum,
    0,
  );
  return {
    version: 2,
    planId: source.planId,
    patientId: source.patientId,
    currency: source.currency,
    clinicName: source.clinicName,
    location: { ...source.location },
    patient: { ...source.patient },
    professionalName: source.professionalName,
    agreement: agreementOf(source.items),
    issuedOn,
    validUntil: addDays(issuedOn, QUOTE_VALIDITY_DAYS),
    validityDays: QUOTE_VALIDITY_DAYS,
    items,
    totals: [
      {
        currency: source.currency,
        gross: fromCents(gross),
        discount: fromCents(discount),
        net: fromCents(gross - discount),
        agreementSaving: fromCents(saving),
      },
    ],
  };
}

const money = (value: number): string => (toCents(value) / 100).toFixed(2);

/**
 * SHA-256 (hex) del presupuesto. Se serializa como un ARRAY JSON de orden fijo
 * con la versión delante (mismo criterio que `computeConsentHash`): no depende
 * del orden de las claves (JSONB lo cambia al guardar), dos documentos
 * distintos no colisionan por correr una frontera entre campos, y el dinero va
 * como texto con 2 decimales, no como el float que haya quedado.
 */
export function computeQuoteHash(content: QuoteContent): string {
  const canonical =
    content.version === 1
      ? canonicalQuoteV1(content)
      : canonicalQuoteV2(content);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Serialización v1, intacta: los presupuestos firmados antes de DX-105 la usan. */
function canonicalQuoteV1(content: QuoteContent): string {
  return JSON.stringify([
    QUOTE_HASH_VERSION,
    content.planId,
    content.patientId,
    content.currency,
    content.clinicName,
    [content.location.id, content.location.name, content.location.address],
    [content.patient.name, content.patient.document],
    content.professionalName,
    content.issuedOn,
    content.validUntil,
    content.validityDays,
    content.items.map((i) => [
      i.id,
      i.toothNumber,
      i.surfaces,
      i.procedure,
      i.quantity,
      money(i.unitPrice),
      money(i.discount),
      money(i.subtotal),
    ]),
    content.totals.map((t) => [
      t.currency,
      money(t.gross),
      money(t.discount),
      money(t.net),
    ]),
  ]);
}

/** v2: v1 más el convenio, el precio de lista por línea y el ahorro. */
function canonicalQuoteV2(content: QuoteContent): string {
  return JSON.stringify([
    QUOTE_HASH_VERSION_V2,
    content.planId,
    content.patientId,
    content.currency,
    content.clinicName,
    [content.location.id, content.location.name, content.location.address],
    [content.patient.name, content.patient.document],
    content.professionalName,
    content.agreement
      ? [content.agreement.name, content.agreement.payerName]
      : null,
    content.issuedOn,
    content.validUntil,
    content.validityDays,
    content.items.map((i) => [
      i.id,
      i.toothNumber,
      i.surfaces,
      i.procedure,
      i.quantity,
      money(i.unitPrice),
      money(i.discount),
      money(i.subtotal),
      i.listPrice === null ? null : money(i.listPrice),
      i.agreementName,
    ]),
    content.totals.map((t) => [
      t.currency,
      money(t.gross),
      money(t.discount),
      money(t.net),
      money(t.agreementSaving),
    ]),
  ]);
}

export interface AcceptanceHashInput {
  contentHash: string;
  signerName: string;
  /** PNG en base64, sin prefijo `data:`. */
  signature: string;
  acceptedAt: Date;
}

/** SHA-256 (hex) que sella la aceptación: contenido + firmante + firma + hora. */
export function computeAcceptanceHash(input: AcceptanceHashInput): string {
  const canonical = JSON.stringify([
    ACCEPTANCE_HASH_VERSION,
    input.contentHash,
    input.signerName,
    input.signature,
    input.acceptedAt.toISOString(),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SURFACES = new Set<string>(Object.values(ToothSurface));

function str(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(key);
  return value;
}

function strOrNull(record: JsonRecord, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(key);
  return value;
}

function num(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(key);
  }
  return value;
}

function numOrNull(record: JsonRecord, key: string): number | null {
  if (record[key] === null) return null;
  return num(record, key);
}

function agreementFrom(record: JsonRecord): QuoteAgreement | null {
  if (record.agreement === null) return null;
  const agreement = rec(record, 'agreement');
  return {
    name: str(agreement, 'name'),
    payerName: str(agreement, 'payerName'),
  };
}

function rec(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  if (!isRecord(value)) throw new Error(key);
  return value;
}

function list(record: JsonRecord, key: string): JsonRecord[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(key);
  return value;
}

function surfacesOf(item: JsonRecord): ToothSurface[] {
  const value = item.surfaces;
  if (
    !Array.isArray(value) ||
    !value.every((s) => typeof s === 'string' && SURFACES.has(s))
  ) {
    throw new Error('surfaces');
  }
  return value as ToothSurface[];
}

/**
 * Lee el presupuesto guardado en `treatment_plan_acceptances.content` (JSONB)
 * validando cada campo. Solo lo escribe la API, así que un fallo aquí es una
 * fila alterada por fuera: se lanza en vez de imprimir algo a medias.
 */
export function parseQuoteContent(value: unknown): QuoteContent {
  try {
    if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
      throw new Error('version');
    }
    const version = value.version;
    const v2 = version === 2;
    const location = rec(value, 'location');
    const patient = rec(value, 'patient');
    return {
      version,
      planId: str(value, 'planId'),
      patientId: str(value, 'patientId'),
      currency: str(value, 'currency'),
      clinicName: str(value, 'clinicName'),
      location: {
        id: str(location, 'id'),
        name: str(location, 'name'),
        address: strOrNull(location, 'address'),
      },
      patient: {
        name: str(patient, 'name'),
        document: strOrNull(patient, 'document'),
      },
      professionalName: strOrNull(value, 'professionalName'),
      agreement: v2 ? agreementFrom(value) : null,
      issuedOn: str(value, 'issuedOn'),
      validUntil: str(value, 'validUntil'),
      validityDays: num(value, 'validityDays'),
      items: list(value, 'items').map((item) => ({
        id: str(item, 'id'),
        toothNumber: str(item, 'toothNumber'),
        surfaces: surfacesOf(item),
        procedure: str(item, 'procedure'),
        quantity: num(item, 'quantity'),
        unitPrice: num(item, 'unitPrice'),
        discount: num(item, 'discount'),
        subtotal: num(item, 'subtotal'),
        listPrice: v2 ? numOrNull(item, 'listPrice') : null,
        agreementName: v2 ? strOrNull(item, 'agreementName') : null,
      })),
      totals: list(value, 'totals').map((total) => ({
        currency: str(total, 'currency'),
        gross: num(total, 'gross'),
        discount: num(total, 'discount'),
        net: num(total, 'net'),
        agreementSaving: v2 ? num(total, 'agreementSaving') : 0,
      })),
    };
  } catch (error) {
    const field = error instanceof Error ? error.message : '?';
    throw new Error(`El presupuesto guardado no es válido (campo ${field})`);
  }
}
