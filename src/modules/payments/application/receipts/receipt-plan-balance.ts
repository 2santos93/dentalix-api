import { Injectable, Logger } from '@nestjs/common';
import { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import type { ReceiptPlanBalance } from '../../domain/receipt-snapshot';

export interface ReceiptPaymentForBalance {
  treatmentPlanId: string;
  amount: number;
  currency: string;
  /** Día civil del abono en su sede: la fecha de la tasa (DX-097). */
  paidOn: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Saldo del plan TRAS un abono que aún no se ha guardado, para la foto del
 * recibo (DX-136). Se calcula ANTES de la transacción del abono (la tasa de
 * cambio puede pedir un proveedor externo y no puede ir dentro): saldo previo
 * de `GetPlanBalanceUseCase` más este abono convertido con la tasa de su día,
 * con el mismo redondeo que el saldo. Nunca bloquea el cobro: si algo falla,
 * devuelve null y el recibo sale sin saldo.
 */
@Injectable()
export class ReceiptPlanBalanceCalculator {
  private readonly logger = new Logger('PaymentReceipts');

  constructor(
    private readonly getPlanBalance: GetPlanBalanceUseCase,
    private readonly convertAmount: ConvertAmountUseCase,
  ) {}

  async afterPayment(
    payment: ReceiptPaymentForBalance,
  ): Promise<ReceiptPlanBalance | null> {
    try {
      const before = await this.getPlanBalance.execute(payment.treatmentPlanId);
      const { rateUsed } = await this.convertAmount.execute({
        amount: payment.amount,
        from: payment.currency,
        to: before.planCurrency,
        date: payment.paidOn,
      });
      const paid = round2(before.paid + round2(payment.amount * rateUsed));
      return {
        currency: before.planCurrency,
        billable: before.billable,
        paid,
        balance: round2(before.billable - paid),
      };
    } catch (error) {
      // Sin datos del abono ni del paciente: solo el tipo del error.
      this.logger.warn({
        event: 'payment_receipt.balance_unavailable',
        error: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }
}
