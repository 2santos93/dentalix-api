import type { PaymentReceiptView } from '../entities/payment-receipt.entity';

export const RECEIPT_EMAIL_SENDER = Symbol('RECEIPT_EMAIL_SENDER');

/**
 * Deja en la cola de email (outbox de DX-088) el recibo para el paciente.
 * Lanza 429 en español si se pasan los topes de envío de la clínica.
 */
export interface ReceiptEmailSender {
  /**
   * `responsibleName`: nombre de pila del responsable al que va (DX-203); el
   * email lo saluda a él y nombra al paciente.
   */
  send(
    to: string,
    receipt: PaymentReceiptView,
    responsibleName?: string | null,
  ): Promise<void>;
}
