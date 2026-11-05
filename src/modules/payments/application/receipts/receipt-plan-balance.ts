import { Injectable, Logger } from '@nestjs/common';
import { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';
import { errorName } from '../payment-in-plan-currency';
import type { ReceiptPlanBalance } from '../../domain/receipt-snapshot';
import type { ReceiptBalanceInTx } from '../../domain/ports/payment-repository.port';
import { round2 } from '../../../../shared/money/money';

/**
 * Saldo del plan TRAS un abono que aún no se ha guardado, para la foto del
 * recibo (DX-136): saldo previo de `GetPlanBalanceUseCase` más este abono ya
 * convertido a la moneda del plan con la tasa de su día (la conversión, que
 * puede pedir un proveedor externo, la hace quien registra el abono, fuera de
 * su transacción), con el mismo redondeo que el saldo. Nunca bloquea el cobro:
 * sin importe convertido o si algo falla, devuelve null y el recibo sale sin
 * saldo.
 */
@Injectable()
export class ReceiptPlanBalanceCalculator {
  private readonly logger = new Logger('PaymentReceipts');

  constructor(private readonly getPlanBalance: GetPlanBalanceUseCase) {}

  async afterPayment(
    treatmentPlanId: string,
    convertedAmount: number | null,
  ): Promise<ReceiptPlanBalance | null> {
    try {
      // Sin tasa el recibo sale sin saldo (misma ruta que cualquier fallo).
      if (convertedAmount === null) {
        this.warnUnavailable('UnsupportedCurrency');
        return null;
      }
      const before = await this.getPlanBalance.execute(treatmentPlanId);
      // DX-054: con el proveedor de tasas fuera de plazo el `paid` previo
      // está incompleto; el recibo (que se congela) sale sin saldo.
      if (before.rateProviderTimedOut) {
        this.warnUnavailable('RateProviderTimedOut');
        return null;
      }
      const paid = round2(before.paid + convertedAmount);
      return {
        currency: before.planCurrency,
        billable: before.billable,
        paid,
        // DX-253: el saldo a favor traspasado o devuelto también cuenta.
        balance: round2(before.billable - paid - before.creditMovements),
      };
    } catch (error) {
      this.warnUnavailable(errorName(error));
      return null;
    }
  }

  /**
   * DX-182: el saldo para el recibo calculado DENTRO de la transacción del
   * abono (`ReceiptBalanceInTx`): el plan ya está bloqueado, así que la foto
   * trae los abonos anteriores y este (con su base), y su cuenta es la del
   * saldo del plan, sin sumar nada a mano. Sin red: lo que pidiera la tasa del
   * día a un proveedor (un abono anterior a DX-375 aún sin congelar, o este
   * mismo sin base) deja el recibo sin saldo, como cualquier saldo ilegible.
   */
  readonly inTransaction: ReceiptBalanceInTx = async ({
    planId,
    snapshot,
    creditMovements,
  }) => {
    try {
      const result = await this.getPlanBalance.fromSnapshot(
        planId,
        snapshot,
        creditMovements,
        { offline: true },
      );
      if (result.rateProviderTimedOut) {
        this.warnUnavailable('RateProviderTimedOut');
        return null;
      }
      return {
        currency: result.planCurrency,
        billable: result.billable,
        paid: result.paid,
        balance: result.balance,
      };
    } catch (error) {
      this.warnUnavailable(errorName(error));
      return null;
    }
  };

  /** Sin datos del abono ni del paciente: solo el tipo del error. */
  private warnUnavailable(error: string): void {
    this.logger.warn({ event: 'payment_receipt.balance_unavailable', error });
  }
}
