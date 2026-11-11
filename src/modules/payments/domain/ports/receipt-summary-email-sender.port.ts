import type { PaymentReceiptSummaryView } from '../receipt-summary';

export const RECEIPT_SUMMARY_EMAIL_SENDER = Symbol(
  'RECEIPT_SUMMARY_EMAIL_SENDER',
);

/**
 * DX-401: deja en la cola de email (outbox de DX-088) el resumen de abonos
 * del período. Lanza 429 en español si se pasan los topes de la clínica.
 */
export interface ReceiptSummaryEmailSender {
  /**
   * `locationId`: la sede cuyo formato (fechas e importes, G1-B) usa el
   * email, la del último recibo del resumen. `responsibleName`: nombre de
   * pila del responsable al que va (DX-203), o null.
   */
  send(
    to: string,
    summary: PaymentReceiptSummaryView,
    locationId: string,
    responsibleName: string | null,
  ): Promise<void>;
}
