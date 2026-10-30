import type { PaymentRateState } from '../payment-exchange-rate';
import type { PaymentBaseRetryReason } from '../payment-base-retry';

/**
 * DX-380: un abono vivo pendiente cuyo reintento ya venció, con lo que hace
 * falta para intentarlo (su tasa y si tiene base), leído en la clínica del
 * contexto.
 */
export interface PaymentBaseRetryCandidate extends PaymentRateState {
  paymentId: string;
  /** Intentos fallidos hasta ahora (0: aún no se intentó en un barrido). */
  attempts: number;
  /**
   * `false`: ya no hay nada que hacer (anulado, o su plan o saldo migrado
   * retirado). El reintento se cierra sin convertir.
   */
  live: boolean;
  amount: number;
  /** Día civil del abono en su sede: la fecha de la tasa (DX-097). */
  paidOn: string;
  /** La moneda del plan, o la del saldo migrado. */
  targetCurrency: string;
  /** La moneda del plan vivo (lleva base); `null` si es a un saldo migrado. */
  planCurrency: string | null;
  hasBase: boolean;
}

/** Un intento fallido: cuántos lleva, por qué y cuánto esperar. */
export interface PaymentBaseRetryFailure {
  attempts: number;
  reason: PaymentBaseRetryReason;
  delayMs: number;
}

/** Abonos sin base de la clínica desde hace más del umbral. */
export interface PaymentBaseBacklog {
  count: number;
  /** Desde cuándo está pendiente el más antiguo (UTC), o null si no hay. */
  oldestSince: Date | null;
}

/**
 * DX-402: los abonos pendientes de un día a los que serviría la tasa manual
 * de una moneda (como tasa de respaldo de un día anterior a `manualSince`).
 */
export interface PaymentRatePendingDay {
  /**
   * Abonos vivos de la clínica en espera de su tasa, de ese día civil (en su
   * sede), cuya moneda o moneda de destino es la de la tasa.
   */
  count: number;
  /**
   * Hay tasa del proveedor guardada para ese día: la de respaldo no se usa
   * (manda la automática).
   */
  providerRateSaved: boolean;
}

export const PAYMENT_BASE_RETRY_REPOSITORY = Symbol(
  'PAYMENT_BASE_RETRY_REPOSITORY',
);

/**
 * Estado de reintento de los abonos sin base (DX-380, `payment_base_retries`,
 * RLS FORCE). Una fila por abono pendiente: la crea la BD al confirmar el
 * alta de un abono que queda sin base o sin tasa (trigger diferido), y se
 * borra cuando el barrido lo resuelve. Todo en la clínica del contexto salvo
 * `dueTenantIds`.
 */
export interface PaymentBaseRetryRepository {
  /**
   * Clínicas vivas con algo que barrer: un reintento vencido o un plan por
   * repartir. Una sola sentencia para todas (sin abrir una transacción por
   * clínica): `dx_payment_allocation_sweep_tenants()`.
   */
  dueTenantIds(): Promise<string[]>;
  /**
   * Hasta `limit` reintentos vencidos (`nextAttemptAt <= now()`), el que
   * venció antes primero (índice ("tenantId", "nextAttemptAt")).
   */
  due(limit: number): Promise<PaymentBaseRetryCandidate[]>;
  /** El abono ya tiene lo que le faltaba (o ya no lo necesita): se borra. */
  resolve(paymentId: string): Promise<void>;
  /** Intento fallido: lo apunta y lo aplaza `delayMs` desde la hora de la BD. */
  postpone(paymentId: string, failure: PaymentBaseRetryFailure): Promise<void>;
  /**
   * Adelanta a ya todos los reintentos aplazados de la clínica (la clínica
   * registró o corrigió una tasa, o cambió de fuente). Devuelve cuántos.
   */
  wake(): Promise<number>;
  /** Abonos vivos pendientes desde hace más de `olderThanHours`. */
  backlog(olderThanHours: number): Promise<PaymentBaseBacklog>;
  /**
   * DX-402: abonos de la clínica que esperan su tasa del día civil `date` y
   * necesitan `currency` (su moneda o la de destino).
   */
  pendingOnDay(date: string, currency: string): Promise<PaymentRatePendingDay>;
}
