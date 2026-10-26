import { Injectable, Logger } from '@nestjs/common';
import { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';
import { errorName } from '../payment-in-plan-currency';
import type { ReceiptPlanBalance } from '../../domain/receipt-snapshot';

const round2 = (value: number): number => Math.round(value * 100) / 100;

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
      const paid = round2(before.paid + convertedAmount);
      return {
        currency: before.planCurrency,
        billable: before.billable,
        paid,
        balance: round2(before.billable - paid),
      };
    } catch (error) {
      this.warnUnavailable(errorName(error));
      return null;
    }
  }

  /** Sin datos del abono ni del paciente: solo el tipo del error. */
  private warnUnavailable(error: string): void {
    this.logger.warn({ event: 'payment_receipt.balance_unavailable', error });
  }
}
