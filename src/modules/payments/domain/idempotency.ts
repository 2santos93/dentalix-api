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

const DAY_MS = 24 * 60 * 60 * 1000;

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
