import {
  convertWithQuote,
  type AmountConverter,
} from '../../exchange/application/use-cases/convert-amount.use-case';
import { BASE_CURRENCY } from '../../exchange/domain/exchange-rate-source';
import {
  exchangeRateStatus,
  type FrozenExchangeRate,
  type PaymentRateState,
} from '../domain/payment-exchange-rate';
import {
  isNoRateError,
  paymentInPlanCurrency,
} from './payment-in-plan-currency';

/** Un abono con su tasa congelada (o no), listo para convertirse. */
export interface PaymentWithRate extends PaymentRateState {
  amount: number;
  /** Día civil del abono en su sede: la fecha de la tasa (DX-097). */
  paidOn: string;
}

/**
 * DX-375: el importe del abono en `target`. Con tasa congelada, siempre con
 * ella (cambiar la tasa después no altera nada); «sin tasa» (`MISSING`) es
 * `null` en su moneda de destino. Un abono anterior a DX-375 aún sin congelar
 * (`LEGACY`), o una moneda de destino distinta de la congelada (totales en
 * otra moneda), se convierte con la tasa de su día, como antes; `null` si
 * no la hay. Cualquier fallo que no sea «sin tasa» se propaga.
 */
export async function paymentAmountIn(
  convert: AmountConverter,
  payment: PaymentWithRate,
  target: string,
): Promise<number | null> {
  if (payment.currency === target) return payment.amount;
  const frozen = payment.frozenRate;
  if (frozen && (frozen.currency === target || target === BASE_CURRENCY)) {
    return convertWithQuote(payment.amount, {
      from: payment.currency,
      to: target,
      fromPerBase: frozen.fromPerBase,
      toPerBase: target === BASE_CURRENCY ? 1 : frozen.toPerBase,
    });
  }
  if (
    exchangeRateStatus(payment) === 'MISSING' &&
    payment.exchangeRateCurrency === target
  ) {
    return null;
  }
  return paymentInPlanCurrency(convert, {
    amount: payment.amount,
    currency: payment.currency,
    planCurrency: target,
    paidOn: payment.paidOn,
  });
}

/**
 * La base de imputación del abono (DX-051, R15) en la moneda de su plan:
 * `paymentAmountIn` y, como la base exige `amount > 0`, un importe que
 * redondea a 0 cuenta como «sin tasa».
 */
export async function paymentBaseAmount(
  convert: AmountConverter,
  payment: PaymentWithRate,
  planCurrency: string,
): Promise<number | null> {
  const amount = await paymentAmountIn(convert, payment, planCurrency);
  return amount !== null && amount > 0 ? amount : null;
}

/**
 * DX-375: la tasa que congela un abono de `currency` a `targetCurrency` el día
 * `paidOn`, con la fuente de la clínica del contexto. `null` si no hay que
 * congelar nada (misma moneda) o si no hay tasa ese día («sin tasa»);
 * cualquier otro fallo se propaga.
 */
export async function freezePaymentRate(
  convert: AmountConverter,
  payment: { currency: string; targetCurrency: string; paidOn: string },
): Promise<FrozenExchangeRate | null> {
  if (payment.currency === payment.targetCurrency) return null;
  try {
    const quote = await convert.quote({
      from: payment.currency,
      to: payment.targetCurrency,
      date: payment.paidOn,
    });
    return {
      currency: payment.targetCurrency,
      fromPerBase: quote.fromPerBase,
      toPerBase: quote.toPerBase,
      source: quote.source,
      date: quote.date,
    };
  } catch (error) {
    if (isNoRateError(error)) return null;
    throw error;
  }
}
