import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENT_RECEIPT_REPOSITORY } from '../../domain/ports/payment-receipt-repository.port';
import type {
  PaymentReceiptRepository,
  PaymentReceiptSource,
} from '../../domain/ports/payment-receipt-repository.port';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';
import {
  buildReceiptSnapshot,
  type ReceiptPlanBalance,
} from '../../domain/receipt-snapshot';
import {
  formatReceiptNumber,
  legacyReceiptReference,
} from '../../domain/receipt-number';
import { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';

export const PAYMENT_NOT_FOUND_MESSAGE = 'No encontramos ese abono.';

export interface LoadedPaymentReceipt {
  view: PaymentReceiptView;
  /** Email actual del paciente (para enviarle el recibo), o null. */
  patientEmail: string | null;
}

/**
 * El recibo de caja de un abono (DX-136), para verlo, reimprimirlo o
 * enviarlo. Un recibo emitido sale SIEMPRE con su foto: mismos datos que al
 * emitirlo aunque después cambien la clínica, el paciente o el saldo. Un
 * abono anterior a la numeración no tiene foto: sale «sin serie», con su
 * referencia antigua y los datos y el saldo de hoy.
 */
@Injectable()
export class GetPaymentReceiptUseCase {
  constructor(
    @Inject(PAYMENT_RECEIPT_REPOSITORY)
    private readonly repo: PaymentReceiptRepository,
    private readonly getPlanBalance: GetPlanBalanceUseCase,
  ) {}

  async execute(paymentId: string): Promise<PaymentReceiptView> {
    return (await this.load(paymentId)).view;
  }

  async load(paymentId: string): Promise<LoadedPaymentReceipt> {
    const source = await this.repo.findByPaymentId(paymentId);
    if (!source) {
      throw new NotFoundException(PAYMENT_NOT_FOUND_MESSAGE);
    }
    return {
      view:
        source.kind === 'issued'
          ? this.issuedView(source)
          : await this.legacyView(source),
      patientEmail: source.patientEmail,
    };
  }

  private issuedView(
    source: Extract<PaymentReceiptSource, { kind: 'issued' }>,
  ): PaymentReceiptView {
    const { receipt } = source;
    return {
      paymentId: source.paymentId,
      reference: formatReceiptNumber(receipt.seriesPrefix, receipt.number),
      seriesPrefix: receipt.seriesPrefix,
      number: receipt.number,
      legacy: false,
      issuedAt: receipt.issuedAt,
      voided: receipt.voidedAt !== null,
      voidedAt: receipt.voidedAt,
      voidReason: receipt.voidReason,
      snapshot: receipt.snapshot,
    };
  }

  private async legacyView(
    source: Extract<PaymentReceiptSource, { kind: 'legacy' }>,
  ): Promise<PaymentReceiptView> {
    const { legacy } = source;
    return {
      paymentId: source.paymentId,
      reference: legacyReceiptReference(source.paymentId),
      seriesPrefix: null,
      number: null,
      legacy: true,
      issuedAt: legacy.issuedAt,
      voided: legacy.voidedAt !== null,
      voidedAt: legacy.voidedAt,
      voidReason: legacy.voidReason,
      snapshot: buildReceiptSnapshot({
        ...legacy.snapshotInput,
        planBalance: await this.currentBalance(source.treatmentPlanId),
      }),
    };
  }

  /** Saldo de hoy del plan; null si no se puede calcular (plan retirado, sin tasa). */
  private async currentBalance(
    treatmentPlanId: string,
  ): Promise<ReceiptPlanBalance | null> {
    try {
      const balance = await this.getPlanBalance.execute(treatmentPlanId);
      return {
        currency: balance.planCurrency,
        billable: balance.billable,
        paid: balance.paid,
        balance: balance.balance,
      };
    } catch {
      return null;
    }
  }
}
