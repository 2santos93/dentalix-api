import { createHash } from 'node:crypto';
import type { Payment } from './entities/payment.entity';
import { amountText } from '../../../shared/money/money';

/** 422 al repetir una Idempotency-Key con otro plan u otro cuerpo (DX-109). */
export const IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'Esta clave de idempotencia ya se usó para otro abono (otro plan o datos distintos). Vuelve a registrar el abono para generar una clave nueva.';

/** Lo que identifica una petición de abono: el plan de la ruta y el cuerpo. */
export interface PaymentRequestShape {
  amount: unknown;
  currency: unknown;
  paidAt: unknown;
  method?: unknown;
  notes?: unknown;
  paymentMethodId?: string;
  reference?: string;
  proofUploadId?: string;
}

const CIVIL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeAmount(amount: unknown): unknown {
  return typeof amount === 'number' && Number.isFinite(amount)
    ? amountText(amount, 2)
    : (amount ?? null);
}

function normalizeCurrency(currency: unknown): unknown {
  return typeof currency === 'string'
    ? currency.trim().toUpperCase()
    : (currency ?? null);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * DX-123 (R-6): unas notas vacías, solo espacios, `null` u omitidas son la
 * misma petición («sin notas»): un cliente que reintenta con `""` en vez de
 * omitirlas recibe el abono original, no un 422. Las notas con texto cuentan
 * tal cual.
 */
function normalizeNotes(notes: unknown): unknown {
  if (notes === undefined || notes === null) return null;
  return typeof notes === 'string' && notes.trim() === '' ? null : notes;
}

/** ¿Normalizar las notas cambia la huella respecto a la anterior a DX-123? */
function blankNotesString(notes: unknown): boolean {
  return typeof notes === 'string' && notes.trim() === '';
}

/**
 * Forma canónica de `paidAt`, la misma que aplica `RecordPaymentUseCase`: el
 * mismo instante escrito de dos formas ISO es la misma petición, y una
 * medianoche UTC exacta (`2026-10-16T00:00:00Z`, clientes anteriores a DX-097)
 * es el día civil `2026-10-16`, porque así se guarda.
 */
function normalizePaidAt(paidAt: unknown): unknown {
  if (typeof paidAt === 'string' && CIVIL_DATE_SHAPE.test(paidAt.trim())) {
    return paidAt.trim();
  }
  const instant =
    paidAt instanceof Date
      ? paidAt
      : typeof paidAt === 'string'
        ? new Date(paidAt.trim())
        : null;
  if (instant === null) return paidAt ?? null;
  if (Number.isNaN(instant.getTime())) return (paidAt as string).trim();
  return instant.getTime() % DAY_MS === 0
    ? instant.toISOString().slice(0, 10)
    : instant.toISOString();
}

/**
 * Huella de la petición (BE-017): SHA-256 (hex) del plan + cuerpo normalizado
 * (importe a 2 decimales, moneda en mayúsculas, fecha ISO). Se guarda con el
 * abono y una repetición de la clave tiene que traer la misma.
 */
export function paymentRequestFingerprint(
  treatmentPlanId: string,
  input: PaymentRequestShape,
): string {
  return paymentFingerprintWithNotes(
    treatmentPlanId,
    input,
    normalizeNotes(input.notes),
  );
}

function paymentFingerprintWithNotes(
  treatmentPlanId: string,
  input: PaymentRequestShape,
  notes: unknown,
): string {
  const normalized = [
    treatmentPlanId.toLowerCase(),
    normalizeAmount(input.amount),
    normalizeCurrency(input.currency),
    normalizePaidAt(input.paidAt),
    input.method ?? null,
    notes,
    // DX-377: solo si vienen, para que las huellas anteriores sigan valiendo.
    ...(input.paymentMethodId || input.reference
      ? [input.paymentMethodId ?? null, input.reference?.trim() ?? null]
      : []),
    // DX-389: el comprobante cuenta (solo si viene, las huellas anteriores
    // siguen valiendo): la misma clave con otro comprobante es 422, no el
    // abono original sin él.
    ...(input.proofUploadId
      ? [`proof:${input.proofUploadId.toLowerCase()}`]
      : []),
  ];
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** DX-390: lo que identifica un cobro dividido: el plan, el día, las líneas. */
export interface SplitPaymentRequestShape {
  paidAt: unknown;
  notes?: unknown;
  lines: {
    amount: unknown;
    currency: unknown;
    paymentMethodId?: string;
    reference?: string;
    proofUploadId?: string;
  }[];
}

/**
 * DX-390: huella de un cobro dividido, con la misma normalización que la de un
 * abono. Lleva una marca propia: nunca coincide con la de un abono suelto, así
 * que la misma clave en el otro endpoint es 422. Ni el motivo de una
 * referencia repetida ni la confirmación del saldo a favor cuentan: el
 * reintento tras esos 409 es la misma petición.
 */
export function splitPaymentRequestFingerprint(
  treatmentPlanId: string,
  input: SplitPaymentRequestShape,
): string {
  return splitFingerprintWithNotes(
    treatmentPlanId,
    input,
    normalizeNotes(input.notes),
  );
}

function splitFingerprintWithNotes(
  treatmentPlanId: string,
  input: SplitPaymentRequestShape,
  notes: unknown,
): string {
  const normalized = [
    'split',
    treatmentPlanId.toLowerCase(),
    normalizePaidAt(input.paidAt),
    notes,
    input.lines.map((line) => [
      normalizeAmount(line.amount),
      normalizeCurrency(line.currency),
      line.paymentMethodId ?? null,
      line.reference?.trim() ?? null,
      ...(line.proofUploadId
        ? [`proof:${line.proofUploadId.toLowerCase()}`]
        : []),
    ]),
  ];
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * DX-123: las huellas con que una petición reconoce su abono. La primera es la
 * canónica (la que se guarda). Una clave guardada ANTES de normalizar las
 * notas con `""` (o espacios) llevaba esas notas tal cual: su reintento
 * idéntico sigue reconociéndose por esa huella antigua.
 */
export function paymentRequestFingerprints(
  treatmentPlanId: string,
  input: PaymentRequestShape,
): string[] {
  const canonical = paymentRequestFingerprint(treatmentPlanId, input);
  return blankNotesString(input.notes)
    ? [
        canonical,
        paymentFingerprintWithNotes(treatmentPlanId, input, input.notes),
      ]
    : [canonical];
}

/** DX-123: `paymentRequestFingerprints` para un cobro dividido. */
export function splitPaymentRequestFingerprints(
  treatmentPlanId: string,
  input: SplitPaymentRequestShape,
): string[] {
  const canonical = splitPaymentRequestFingerprint(treatmentPlanId, input);
  return blankNotesString(input.notes)
    ? [
        canonical,
        splitFingerprintWithNotes(treatmentPlanId, input, input.notes),
      ]
    : [canonical];
}

/**
 * El destino de un abono para la idempotencia: el id del plan (como siempre,
 * así las huellas anteriores siguen valiendo) o `ob:<id>` si es contra un
 * saldo migrado (DX-262).
 */
export function paymentTargetKey(target: {
  treatmentPlanId: string | null;
  openingBalanceId: string | null;
}): string {
  return target.treatmentPlanId ?? `ob:${target.openingBalanceId ?? ''}`;
}

/** Un abono ya registrado con una Idempotency-Key y la huella de su petición. */
export interface IdempotentPayment {
  payment: Payment;
  /** `null` en abonos anteriores a DX-109: solo se compara el plan. */
  requestFingerprint: string | null;
}

/** ¿Es esta petición una repetición idéntica de la que creó `stored`? */
export function isSameRequest(
  stored: IdempotentPayment,
  /** `paymentTargetKey` de la petición (el id del plan para un plan). */
  treatmentPlanId: string,
  /** La huella de la petición, o todas las que la reconocen (DX-123). */
  requestFingerprint: string | readonly string[],
): boolean {
  if (paymentTargetKey(stored.payment) !== treatmentPlanId) return false;
  if (stored.requestFingerprint === null) return true;
  const accepted =
    typeof requestFingerprint === 'string'
      ? [requestFingerprint]
      : requestFingerprint;
  return accepted.includes(stored.requestFingerprint);
}
