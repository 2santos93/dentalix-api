import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GetPaymentReceiptUseCase } from './get-payment-receipt.use-case';
import { RECEIPT_EMAIL_SENDER } from '../../domain/ports/receipt-email-sender.port';
import type { ReceiptEmailSender } from '../../domain/ports/receipt-email-sender.port';
import { maskEmail } from '../../../../shared/privacy/mask-email';

export const PATIENT_WITHOUT_EMAIL_MESSAGE =
  'El paciente no tiene un email registrado. Añádelo en su ficha para enviarle el recibo.';

export interface SendPaymentReceiptResult {
  /** Destino enmascarado (`an***@dominio`): nunca el email completo. */
  sentTo: string;
}

/**
 * Reenvía por email el MISMO recibo que se ve y se imprime (DX-136) al email
 * actual del paciente. Sale por el outbox de DX-088: la petición no espera al
 * proveedor, y los topes de la clínica responden 429 en español.
 */
@Injectable()
export class SendPaymentReceiptUseCase {
  constructor(
    private readonly getReceipt: GetPaymentReceiptUseCase,
    @Inject(RECEIPT_EMAIL_SENDER)
    private readonly sender: ReceiptEmailSender,
  ) {}

  async execute(paymentId: string): Promise<SendPaymentReceiptResult> {
    const { view, patientEmail } = await this.getReceipt.load(paymentId);
    if (!patientEmail) {
      throw new UnprocessableEntityException(PATIENT_WITHOUT_EMAIL_MESSAGE);
    }
    await this.sender.send(patientEmail, view);
    return { sentTo: maskEmail(patientEmail) };
  }
}
