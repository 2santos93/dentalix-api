import { createHash } from 'node:crypto';
import type { Payment } from './entities/payment.entity';

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
}

const CIVIL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeAmount(amount: unknown): unknown {
  return typeof amount === 'number' && Number.isFinite(amount)
    ? amount.toFixed(2)
    : (amount ?? null);
}

function normalizeCurrency(currency: unknown): unknown {
  return typeof currency === 'string'
    ? currency.trim().toUpperCase()
    : (currency ?? null);
}

/** El mismo instante escrito de dos formas ISO es la misma petición. */
function normalizePaidAt(paidAt: unknown): unknown {
  if (paidAt instanceof Date) return paidAt.toISOString();
  if (typeof paidAt !== 'string') return paidAt ?? null;
  const trimmed = paidAt.trim();
  if (CIVIL_DATE_SHAPE.test(trimmed)) return trimmed;
  const instant = new Date(trimmed);
  return Number.isNaN(instant.getTime()) ? trimmed : instant.toISOString();
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
  const normalized = [
    treatmentPlanId.toLowerCase(),
    normalizeAmount(input.amount),
    normalizeCurrency(input.currency),
    normalizePaidAt(input.paidAt),
    input.method ?? null,
    input.notes ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
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
  treatmentPlanId: string,
  requestFingerprint: string,
): boolean {
  if (stored.payment.treatmentPlanId !== treatmentPlanId) return false;
  return (
    stored.requestFingerprint === null ||
    stored.requestFingerprint === requestFingerprint
  );
}
