import { createHash } from 'node:crypto';
import { ToothSurface } from '@prisma/client';

/** «Válido 30 días»: el presupuesto caduca 30 días naturales después de emitirse. */
export const QUOTE_VALIDITY_DAYS = 30;

const QUOTE_HASH_VERSION = 'dentalix-plan-quote-v1';
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
}

export interface QuoteLocation {
  id: string;
  name: string;
  address: string | null;
}

export interface QuotePatient {
  name: string;
  /** «CC 123…», o `null` si el paciente no tiene documento. */
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
}

export interface QuoteTotal {
  currency: string;
  gross: number;
  discount: number;
  net: number;
}

/**
 * El presupuesto tal como se presenta (y, si se acepta, tal como se firma y se
 * guarda): todo lo que el hash sella. No incluye el logo (es marca, no
 * contenido) ni el estado del plan.
 */
export interface QuoteContent {
  version: 1;
  planId: string;
  patientId: string;
  currency: string;
  clinicName: string;
  location: QuoteLocation;
  patient: QuotePatient;
  professionalName: string | null;
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
  }));
  const gross = items.reduce((sum, i) => sum + toCents(i.unitPrice), 0);
  const discount = items.reduce((sum, i) => sum + toCents(i.discount), 0);
  return {
    version: 1,
    planId: source.planId,
    patientId: source.patientId,
    currency: source.currency,
    clinicName: source.clinicName,
    location: { ...source.location },
    patient: { ...source.patient },
    professionalName: source.professionalName,
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
  const canonical = JSON.stringify([
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
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
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
    if (!isRecord(value) || value.version !== 1) throw new Error('version');
    const location = rec(value, 'location');
    const patient = rec(value, 'patient');
    return {
      version: 1,
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
      })),
      totals: list(value, 'totals').map((total) => ({
        currency: str(total, 'currency'),
        gross: num(total, 'gross'),
        discount: num(total, 'discount'),
        net: num(total, 'net'),
      })),
    };
  } catch (error) {
    const field = error instanceof Error ? error.message : '?';
    throw new Error(`El presupuesto guardado no es válido (campo ${field})`);
  }
}
