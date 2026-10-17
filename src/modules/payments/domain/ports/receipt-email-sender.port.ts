import type { PaymentReceiptView } from '../entities/payment-receipt.entity';

export const RECEIPT_EMAIL_SENDER = Symbol('RECEIPT_EMAIL_SENDER');

/**
 * Deja en la cola de email (outbox de DX-088) el recibo para el paciente.
 * Lanza 429 en español si se pasan los topes de envío de la clínica.
 */
export interface ReceiptEmailSender {
  send(to: string, receipt: PaymentReceiptView): Promise<void>;
}
