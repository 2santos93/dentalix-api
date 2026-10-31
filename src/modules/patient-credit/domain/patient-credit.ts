import { createHash } from 'node:crypto';
import { ClinicRole, type PaymentMethod } from '@prisma/client';
import { RECEIPT_PREFIX_PATTERN } from '../../payments/domain/receipt-number';
import type { RoundingDigits } from '../../../shared/money/line-rounding';
import { fromCents, toCents } from '../../../shared/money/money';

/*
 * Saldo a favor del paciente (DX-253): reglas puras del traspaso a otro plan y
 * de la devolución. Todo en céntimos enteros (DECIMAL(14,2) cabe exacto).
 *
 * SALDO A FAVOR de un plan = abonado vivo en la moneda del plan + asientos del
 * saldo a favor (traspasos recibidos − traspasos dados − devoluciones) −
 * facturable (0 si el plan está cancelado o rechazado), si es positivo. Es la
 * misma cifra que el estado de cuenta muestra como saldo negativo del plan
 * (`computeBalances`). Lo abonado en OTRA moneda que la del plan no entra: el
 * traspaso entre monedas está fuera de alcance.
 */

export const CREDIT_REASON_MIN = 3;
export const CREDIT_REASON_MAX = 500;
export const CREDIT_MAX_REFERENCE_PAYMENTS = 20;

export const CREDIT_PLAN_NOT_FOUND_MESSAGE =
  'Plan de tratamiento no encontrado.';
export const CREDIT_REFUND_NOT_FOUND_MESSAGE = 'Devolución no encontrada.';
export const CREDIT_AMOUNT_EXCEEDS_MESSAGE =
  'El importe supera el saldo a favor del plan.';
export const CREDIT_CURRENCY_MISMATCH_MESSAGE =
  'La moneda no es la del plan: el saldo a favor se mueve en la moneda del plan de origen.';
export const CREDIT_TARGET_CURRENCY_MESSAGE =
  'El plan de destino tiene otra moneda: el traspaso entre monedas no está disponible.';
export const CREDIT_SAME_PLAN_MESSAGE =
  'El plan de destino tiene que ser distinto del de origen.';
export const CREDIT_TARGET_OTHER_PATIENT_MESSAGE =
  'El plan de destino es de otro paciente: el saldo a favor solo se aplica a planes del mismo paciente.';
export const CREDIT_TARGET_NOT_BILLABLE_MESSAGE =
  'El plan de destino está cancelado o rechazado: elige un plan vivo.';
export const CREDIT_REASON_REQUIRED_MESSAGE = `El motivo es obligatorio (de ${CREDIT_REASON_MIN} a ${CREDIT_REASON_MAX} caracteres).`;
export const CREDIT_PAYMENTS_REQUIRED_MESSAGE =
  'Indica al menos un abono de referencia de la devolución.';
export const CREDIT_PAYMENT_NOT_OF_PLAN_MESSAGE =
  'Un abono de referencia no es de este plan, está anulado o no existe.';
export const CREDIT_CHANGED_MESSAGE =
  'El saldo a favor o el plan cambiaron mientras se registraba (otro traspaso, otra devolución o un cambio de moneda del plan): revisa el saldo y vuelve a intentarlo.';
export const CREDIT_CASH_SESSION_REQUIRED_MESSAGE =
  'Esta clínica exige caja abierta para mover efectivo: abre tu caja en esta sede antes de devolver en efectivo.';
export const CREDIT_IDEMPOTENCY_REUSED_MESSAGE =
  'Esta clave de idempotencia ya se usó para otro movimiento de saldo a favor. Vuelve a intentarlo para generar una clave nueva.';
export const CREDIT_IDEMPOTENCY_INVALID_MESSAGE =
  'La cabecera Idempotency-Key tiene que ser un UUID.';
export const CREDIT_ROLE_FORBIDDEN_MESSAGE =
  'Tu rol no mueve saldo a favor: solo administración y recepción.';

/** 409 al anular un abono que es referencia de una devolución (DX-253). */
export function voidRefundReferenceMessage(refundNumber: string): string {
  return `No se puede anular: el abono es referencia de la devolución ${refundNumber}: una devolución no se deshace y el abono queda como su traza contable.`;
}
export const VOID_MOVED_CREDIT_MESSAGE =
  'No se puede anular: parte del saldo a favor de este plan ya se traspasó o se devolvió y, sin este abono, el plan quedaría debiendo ese dinero.';

/**
 * D1 (QA): el efectivo sale del cajón de UNA sede; sin `X-Location-Id` (vista
 * «Todas las sedes») no se elige por defecto otra sede ni se deja fuera del
 * arqueo: 400.
 */
export const CREDIT_CASH_LOCATION_REQUIRED_MESSAGE =
  'Elige la sede de la caja de la que sale el efectivo.';

/**
 * El tope con los decimales de redondeo de su moneda y su código («10000.50 USD»,
 * «5000 JPY»). Sin separador de miles a propósito: el dominio no conoce el
 * formato regional de la sede (DX-311, sin locales fijos).
 */
function capText(
  capCents: number,
  currency: string,
  digits: RoundingDigits,
): string {
  return `${(capCents / 100).toFixed(digits)} ${currency}`;
}

/** 403 de RECEPTION por encima del tope de la clínica (mismo patrón que DX-204). */
export function receptionCapMessage(
  capCents: number,
  currency: string,
  digits: RoundingDigits,
): string {
  return capCents === 0
    ? 'Recepción no puede traspasar ni devolver saldo a favor en esta clínica: pídeselo a administración.'
    : `Recepción puede mover hasta ${capText(capCents, currency, digits)} por operación: pídeselo a administración.`;
}

export { fromCents, toCents };

export interface PlanCreditInput {
  /** Facturable del plan (0 si no se cobra: cancelado o rechazado). */
  billableCents: number;
  /** Abonos vivos al plan en su moneda. */
  paidCents: number;
  /** Σ asientos del saldo a favor del plan en su moneda (con signo). */
  entriesCents: number;
}

/** Saldo a favor disponible del plan (nunca negativo). */
export function planCreditCents(input: PlanCreditInput): number {
  return Math.max(
    0,
    input.paidCents + input.entriesCents - input.billableCents,
  );
}

export interface VoidCreditInput extends PlanCreditInput {
  /** Σ de lo que ya SALIÓ del plan (traspasos dados + devoluciones), > 0. */
  outflowCents: number;
  /** Lo que se anula ahora en la moneda del plan (todas las líneas). */
  voidedCents: number;
}

/**
 * ¿Deja la anulación al descubierto saldo a favor ya traspasado o devuelto?
 * Regla (DX-253): si del plan ya salió dinero (traspaso o devolución), tras
 * anular el abono el saldo a favor neto del plan no puede quedar negativo:
 * abonado vivo − anulado + asientos − facturable ≥ 0. Sin salidas, anular es
 * lo de siempre (la deuda que quede es real).
 */
export function voidUncoversMovedCredit(input: VoidCreditInput): boolean {
  if (input.outflowCents <= 0 || input.voidedCents <= 0) return false;
  return (
    input.paidCents -
      input.voidedCents +
      input.entriesCents -
      input.billableCents <
    0
  );
}

/**
 * ¿Puede este rol mover este importe? ADMIN siempre; RECEPTION hasta el tope
 * de la clínica (inclusive; 0 = nada); el resto, nunca (el guard ya los para).
 */
export function canMoveCredit(
  role: ClinicRole,
  amountCents: number,
  receptionCapCents: number,
): boolean {
  if (role === ClinicRole.ADMIN) return true;
  if (role === ClinicRole.RECEPTION) return amountCents <= receptionCapCents;
  return false;
}

/** El motivo recortado si es válido, o `null`. */
export function normalizeReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  const length = Array.from(trimmed).length;
  return length >= CREDIT_REASON_MIN && length <= CREDIT_REASON_MAX
    ? trimmed
    : null;
}

/** Serie del comprobante de devolución de una sede: `DEV-<serie del recibo>`. */
export function refundSeriesOf(receiptPrefix: string): string {
  if (!RECEIPT_PREFIX_PATTERN.test(receiptPrefix)) {
    throw new RangeError(`Serie de recibo inválida: ${receiptPrefix}`);
  }
  return `DEV-${receiptPrefix}`;
}

/** Número visible del comprobante: `DEV-BOG-000007`. */
export function formatRefundNumber(series: string, number: number): string {
  if (!Number.isInteger(number) || number <= 0) {
    throw new RangeError(`Número de comprobante inválido: ${number}`);
  }
  return `${series}-${String(number).padStart(6, '0')}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La clave recortada, `undefined` si viene vacía, o `null` si no es un UUID. */
export function parseIdempotencyKey(
  raw: string | undefined,
): string | undefined | null {
  const key = raw?.trim();
  if (!key) return undefined;
  return UUID_RE.test(key) ? key.toLowerCase() : null;
}

/** Huella de un traspaso (como DX-109): plan, destino, importe, moneda, motivo. */
export function transferFingerprint(input: {
  sourcePlanId: string;
  targetPlanId: string;
  amountCents: number;
  currency: string;
  reason: string | null;
}): string {
  return sha([
    'TRANSFER',
    input.sourcePlanId.toLowerCase(),
    input.targetPlanId.toLowerCase(),
    input.amountCents,
    input.currency.toUpperCase(),
    input.reason,
  ]);
}

/** Huella de una devolución: los abonos de referencia en orden estable. */
export function refundFingerprint(input: {
  planId: string;
  amountCents: number;
  currency: string;
  method: PaymentMethod;
  reason: string;
  paymentIds: readonly string[];
}): string {
  return sha([
    'REFUND',
    input.planId.toLowerCase(),
    input.amountCents,
    input.currency.toUpperCase(),
    input.method,
    input.reason,
    [...new Set(input.paymentIds.map((id) => id.toLowerCase()))].sort(),
  ]);
}

function sha(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
