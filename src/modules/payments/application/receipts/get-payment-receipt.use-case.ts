import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENT_RECEIPT_REPOSITORY } from '../../domain/ports/payment-receipt-repository.port';
import type {
  PaymentReceiptRepository,
  PaymentReceiptSource,
  ReceiptNoticeData,
} from '../../domain/ports/payment-receipt-repository.port';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';
import {
  buildReceiptSnapshot,
  receiptPatientView,
  type ReceiptPlanBalance,
  type ReceiptSnapshot,
  type ReceiptViewSnapshot,
} from '../../domain/receipt-snapshot';
import type { ClinicDocumentTypeNames } from '../../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../../patients/domain/ports/document-type-names-repository.port';
import {
  formatReceiptNumber,
  legacyReceiptReference,
} from '../../domain/receipt-number';
import { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';

export const PAYMENT_NOT_FOUND_MESSAGE = 'No encontramos ese abono.';

function viewSnapshot(
  snapshot: ReceiptSnapshot,
  names: ClinicDocumentTypeNames,
): ReceiptViewSnapshot {
  return { ...snapshot, patient: receiptPatientView(snapshot, names) };
}

export interface LoadedPaymentReceipt {
  view: PaymentReceiptView;
  /** Email actual del paciente (para enviarle el recibo), o null. */
  patientEmail: string | null;
  /** DX-203: para decidir si va al responsable. */
  notice: ReceiptNoticeData;
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
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  async execute(paymentId: string): Promise<PaymentReceiptView> {
    return (await this.load(paymentId)).view;
  }

  async load(paymentId: string): Promise<LoadedPaymentReceipt> {
    const source = await this.repo.findByPaymentId(paymentId);
    if (!source) {
      throw new NotFoundException(PAYMENT_NOT_FOUND_MESSAGE);
    }
    // DX-327 (spec §4.6): el nombre visible del documento se resuelve AQUÍ,
    // una vez, y de la vista salen la pantalla, el papel y el email.
    const names = await this.documentTypeNames.get();
    return {
      view:
        source.kind === 'issued'
          ? this.issuedView(source, names)
          : await this.legacyView(source, names),
      patientEmail: source.patientEmail,
      notice: source.notice,
    };
  }

  private issuedView(
    source: Extract<PaymentReceiptSource, { kind: 'issued' }>,
    names: ClinicDocumentTypeNames,
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
      snapshot: viewSnapshot(receipt.snapshot, names),
    };
  }

  private async legacyView(
    source: Extract<PaymentReceiptSource, { kind: 'legacy' }>,
    names: ClinicDocumentTypeNames,
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
      snapshot: viewSnapshot(
        buildReceiptSnapshot(
          {
            ...legacy.snapshotInput,
            planBalance: source.treatmentPlanId
              ? await this.currentBalance(source.treatmentPlanId)
              : null,
          },
          names,
        ),
        names,
      ),
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
