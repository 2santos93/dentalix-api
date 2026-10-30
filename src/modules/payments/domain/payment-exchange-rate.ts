import type { ExchangeRateSource } from '../../exchange/domain/exchange-rate-source';

/**
 * DX-375: la tasa que congeló un abono, para siempre. Las dos monedas en
 * unidades por 1 USD tal como las dio la fuente de la clínica ese día, así la
 * conversión es la misma, céntimo a céntimo, que con la tasa en vivo.
 */
export interface FrozenExchangeRate {
  /** Moneda de destino: la del plan (o la del saldo migrado). */
  currency: string;
  /** Unidades de la moneda del abono por 1 USD. */
  fromPerBase: number;
  /** Unidades de `currency` por 1 USD. */
  toPerBase: number;
  source: ExchangeRateSource;
  /** Día civil de la tasa: el del abono en su sede. */
  date: string;
}

/**
 * - `NOT_NEEDED`: el abono está en la moneda de su destino.
 * - `FROZEN`: congeló su tasa.
 * - `MISSING`: «sin tasa»: no había tasa de su día al registrarse; no cuenta
 *   en el saldo hasta que el barrido la congele.
 * - `LEGACY`: anterior a DX-375 en otra moneda y aún sin congelar: se lee con
 *   la tasa de su día, como antes, hasta que el barrido la congele.
 */
export type PaymentExchangeRateStatus =
  'NOT_NEEDED' | 'FROZEN' | 'MISSING' | 'LEGACY';

export const PAYMENT_EXCHANGE_RATE_STATUSES: readonly PaymentExchangeRateStatus[] =
  ['NOT_NEEDED', 'FROZEN', 'MISSING', 'LEGACY'];

/** Lo que el abono guarda de su tasa. */
export interface PaymentRateState {
  currency: string;
  /** NULL = anterior a DX-375 (o de una réplica anterior) sin relleno. */
  exchangeRateCurrency: string | null;
  frozenRate: FrozenExchangeRate | null;
}

export function exchangeRateStatus(
  payment: PaymentRateState,
): PaymentExchangeRateStatus {
  if (payment.frozenRate) return 'FROZEN';
  if (payment.exchangeRateCurrency === null) return 'LEGACY';
  return payment.currency === payment.exchangeRateCurrency
    ? 'NOT_NEEDED'
    : 'MISSING';
}
