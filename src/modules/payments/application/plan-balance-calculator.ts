import { Injectable } from '@nestjs/common';
import { TreatmentPlanItemStatus } from '@prisma/client';
import { isPlanBillable } from '../../treatment-plans/domain/plan-status-machine';
import {
  type AmountConverter,
  ConvertAmountUseCase,
} from '../../exchange/application/use-cases/convert-amount.use-case';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateProviderNotRespondingError,
} from '../../exchange/domain/ports/exchange-rate-provider.port';
import { paymentAmountIn } from './payment-exchange-rate';
import {
  CONVERSION_TIMED_OUT,
  conversionDeadline,
  type ConversionDeadline,
} from './conversion-deadline';
import { round2 } from '../../../shared/money/money';
import { linesTotal } from '../../../shared/money/line-rounding';
import type {
  GetPlanBalanceResult,
  PaymentWithoutRate,
  PlanBalanceInput,
} from './use-cases/get-plan-balance.use-case';

/** Las conversiones de UN cálculo: un convertidor y un plazo compartidos. */
interface ConversionRun {
  convert: AmountConverter;
  deadline: ConversionDeadline;
}

/** Sale de la conversión sin pasar por el «sin tasa» de `paymentAmountIn`. */
const PROVIDER_UNANSWERED = new Error('PROVIDER_UNANSWERED');

const BILLABLE_STATUSES: ReadonlySet<TreatmentPlanItemStatus> = new Set([
  TreatmentPlanItemStatus.ACCEPTED,
  TreatmentPlanItemStatus.DONE,
]);

/**
 * El saldo de un plan (DX-472): lo facturable menos lo abonado, cada abono en
 * la moneda del plan por su base, su tasa congelada o, si es anterior a
 * DX-375 y aún sin congelar, la tasa de su día. Es la ÚNICA cuenta: la usan
 * `/balance`, el plan de pagos, el estado de cuenta, el selector de cobro, la
 * cartera y el chip «Saldo vencido» (DX-472-bis). Solo depende del
 * convertidor, así que cualquier módulo la inyecta sin traer el de abonos.
 */
@Injectable()
export class PlanBalanceCalculator {
  constructor(private readonly convertAmount: ConvertAmountUseCase) {}

  /**
   * El saldo de varios planes sobre datos ya leídos, con UN solo plazo para
   * todos: un estado de cuenta o una cartera con muchos planes tampoco espera
   * más de `BALANCE_CONVERSION_BUDGET_MS` al proveedor.
   */
  async computeMany(
    inputs: readonly PlanBalanceInput[],
  ): Promise<Map<string, GetPlanBalanceResult>> {
    const run = this.conversionRun();
    const balances = new Map<string, GetPlanBalanceResult>();
    try {
      for (const input of inputs) {
        balances.set(input.plan.id, await this.compute(input, run));
      }
    } finally {
      run.deadline.dispose();
    }
    return balances;
  }

  private conversionRun(): ConversionRun {
    // DX-374: un convertidor por cálculo, que lee la fuente de la clínica y
    // las tasas de cada día una sola vez (no una lectura por abono). Con la
    // tasa congelada (DX-375) ni siquiera se usa: solo los abonos anteriores
    // aún sin congelar se convierten con la tasa de su día.
    const memoized = this.convertAmount.memoized();
    // DX-054: un proveedor lento o colgado no retiene el saldo: todas las
    // conversiones en vivo comparten un plazo y lo que no llegue sale «sin
    // tasa», como un abono que el proveedor no puede convertir.
    const deadline = conversionDeadline();
    // Vencido el plazo no se lanza ni una petición más a un proveedor que ya
    // no responde a tiempo: la conversión en vivo queda pendiente y `race`
    // la da por vencida al instante. Lo que no pide tasa (misma moneda, tasa
    // congelada) no pasa por aquí y sigue sumando.
    const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
    // DX-472: un proveedor que no contesta o sin cupo no dice que falte la
    // tasa: el saldo pide reintentar. Solo ese abono se queda sin contar; los
    // demás siguen, y los días con tasa guardada suman.
    const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
      if (deadline.timedOut) return never();
      try {
        return await work();
      } catch (error) {
        if (
          error instanceof ExchangeRateProviderNotRespondingError ||
          error instanceof ExchangeRateBudgetExceededError
        ) {
          throw PROVIDER_UNANSWERED;
        }
        throw error;
      }
    };
    return {
      deadline,
      convert: {
        execute: (input) => guarded(() => memoized.execute(input)),
        quote: (input) => guarded(() => memoized.quote(input)),
      },
    };
  }

  private async compute(
    input: PlanBalanceInput,
    { convert, deadline }: ConversionRun,
  ): Promise<GetPlanBalanceResult> {
    const { plan, payments, baseOf } = input;
    // DX-109 (BE-001): un plan no cobrable (rechazado o cancelado) no debe
    // nada, la misma regla que el estado de cuenta; sus abonos siguen en
    // `paid`.
    const billable = !isPlanBillable(plan.status)
      ? 0
      : // DX-340: suma exacta de las líneas cobrables (regla única).
        (input.billable ??
        linesTotal(
          input.items.filter((item) => BILLABLE_STATUSES.has(item.status)),
        ));

    let paid = input.paidKnown ?? 0;
    const paymentsWithoutRate: PaymentWithoutRate[] = [];
    let rateProviderTimedOut = false;
    for (const payment of payments) {
      // IMP-4a/4b: cada abono se convierte por su propio importe (nunca
      // reutilizando un `rateUsed`, que depende del importe), y uno sin tasa
      // no tumba el saldo: no cuenta en `paid` y se informa «sin tasa»
      // (`paymentsCount` no cambia). Cualquier otro fallo se propaga.
      const base = baseOf.get(payment.id);
      const converted =
        base ??
        (await deadline
          .race(paymentAmountIn(convert, payment, plan.currency))
          .catch((error: unknown): typeof CONVERSION_TIMED_OUT => {
            if (error === PROVIDER_UNANSWERED) return CONVERSION_TIMED_OUT;
            throw error;
          }));
      if (converted === CONVERSION_TIMED_OUT) rateProviderTimedOut = true;
      if (converted === null || converted === CONVERSION_TIMED_OUT) {
        paymentsWithoutRate.push({
          paymentId: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          paidOn: payment.paidOn,
        });
        continue;
      }
      paid += converted;
    }

    const creditMovements = round2(input.creditMovements);
    return {
      planCurrency: plan.currency,
      billable,
      paid: round2(paid),
      creditMovements,
      balance: round2(billable - paid - creditMovements),
      paymentsCount: payments.length,
      paymentsWithoutRate,
      rateProviderTimedOut,
    };
  }
}
