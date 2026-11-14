import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export const EXTERNAL_INVOICE_REPOSITORY = Symbol(
  'EXTERNAL_INVOICE_REPOSITORY',
);

/** DX-515: el nº de factura externa ya guardado en el abono (y su cobro). */
export interface ExternalInvoiceNumberResult {
  paymentId: string;
  externalInvoiceNumber: string | null;
  /** Los abonos que lo llevan: el pedido, o todas las líneas de su cobro dividido. */
  paymentIds: string[];
}

export type SetExternalInvoiceOutcome =
  | { kind: 'saved'; result: ExternalInvoiceNumberResult }
  | { kind: 'not-found' }
  | { kind: 'voided' };

export interface ExternalInvoiceRepository {
  /**
   * Pone (o quita, con `null`) el nº de factura externa de un abono vivo y,
   * en un cobro dividido, de todas sus líneas vivas, con su evento de
   * auditoría (antes y después) en la MISMA transacción. El recibo emitido no
   * se toca.
   */
  set(
    paymentId: string,
    value: string | null,
    ctx: AuditRequestContext,
  ): Promise<SetExternalInvoiceOutcome>;
}
