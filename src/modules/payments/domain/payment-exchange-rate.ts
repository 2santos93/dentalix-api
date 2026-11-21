import type { ExchangeRateSource } from '../../exchange/domain/exchange-rate-source';
import { toRateColumn } from '../../../shared/money/rate-conversion';

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
  /**
   * Día civil de la tasa USADA (`exchangeRateDate`). Es el del abono en su
   * sede salvo con tasa manual cuando la clínica no registró la de ese día y
   * se usó la última dentro de su plazo (DX-384): entonces es anterior.
   */
  date: string;
  /**
   * DX-384: el día del abono (en su sede) para el que se cotizó. No se guarda
   * (se deduce del abono): al registrar, solo se congela una tasa cotizada
   * para el día en que el abono quedó. Ausente en una tasa leída de la fila.
   */
  quotedOn?: string;
  /**
   * DX-402: es la tasa manual de un día anterior a `manualSince` (la de
   * respaldo de un día sin tasa del proveedor). No se guarda en el abono
   * (su fuente queda MANUAL y su día, el del abono): solo para auditarlo.
   */
  backup?: { manualSince: string };
  /**
   * DX-586: referencia estable a la tasa usada (`exchangeRateRef`):
   * `BCV:<fecha valor>`, `AUTOMATIC:<día>`, `MANUAL:<id>` (dos unidas con
   * «+») u `OVERRIDE:<día>` (la que fijó recepción, DX-569). `null`/ausente
   * en los abonos congelados antes de DX-586.
   */
  ref?: string | null;
  /** DX-586: fecha valor del BCV (solo con fuente BCV); si no, null. */
  valueDate?: string | null;
  /**
   * DX-586: cuándo se cotizó (hora de la BD al congelar). Solo en una tasa
   * leída de la fila; `null`/ausente en las congeladas antes de DX-586.
   */
  quotedAt?: Date | null;
}

/**
 * DX-586: la tasa usada tal como se enseña: «1 {unit} = {rate} {currency}»,
 * con `unit` la moneda más fuerte de las dos (la de menos unidades por USD),
 * de qué fuente, con qué fecha valor (BCV), cuándo se cotizó y su referencia.
 * Solo en los abonos congelados desde DX-586 (con referencia).
 */
export interface PaymentRateUsed {
  /** Unidades de `currency` por 1 `unit` (hasta 8 decimales). */
  rate: number;
  unit: string;
  currency: string;
  source: ExchangeRateSource;
  valueDate: string | null;
  /** ISO 8601. */
  quotedAt: string;
  ref: string;
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

/**
 * DX-586: la tasa usada de un abono de `paymentCurrency` con su tasa
 * congelada, o `null` si no la tiene o se congeló antes de DX-586 (sin
 * referencia ni instante: esos abonos y sus recibos no cambian).
 */
export function paymentRateUsed(
  paymentCurrency: string,
  frozen: FrozenExchangeRate | null,
): PaymentRateUsed | null {
  if (!frozen?.ref || !frozen.quotedAt) return null;
  const paymentIsStronger = frozen.fromPerBase <= frozen.toPerBase;
  const [unit, currency] = paymentIsStronger
    ? [paymentCurrency, frozen.currency]
    : [frozen.currency, paymentCurrency];
  return {
    rate: toRateColumn(
      paymentIsStronger
        ? frozen.toPerBase / frozen.fromPerBase
        : frozen.fromPerBase / frozen.toPerBase,
    ),
    unit,
    currency,
    source: frozen.source,
    valueDate: frozen.valueDate ?? null,
    quotedAt: frozen.quotedAt.toISOString(),
    ref: frozen.ref,
  };
}
