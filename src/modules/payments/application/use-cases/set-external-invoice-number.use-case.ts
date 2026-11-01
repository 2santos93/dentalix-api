import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  EXTERNAL_INVOICE_REPOSITORY,
  type ExternalInvoiceNumberResult,
  type ExternalInvoiceRepository,
} from '../../domain/ports/external-invoice-repository.port';
import {
  EXTERNAL_INVOICE_NUMBER_MAX,
  EXTERNAL_INVOICE_NUMBER_MESSAGE,
  normalizeReceiptText,
} from '../../domain/receipt-settings';
import { PAYMENT_NOT_FOUND_MESSAGE } from '../receipts/get-payment-receipt.use-case';

export const EXTERNAL_INVOICE_VOIDED_MESSAGE =
  'Ese abono está anulado: ya no se le anota el nº de factura externa.';

/**
 * DX-515: anota (o quita, vacío) en un abono el nº de la factura fiscal que la
 * clínica emitió fuera de Dentalix. Texto libre, sin formato; ADMIN y RECEPTION
 * (lo exige la ruta). Se puede cambiar después de emitir el recibo: el recibo
 * no cambia, el cambio queda auditado con su antes y su después.
 */
@Injectable()
export class SetExternalInvoiceNumberUseCase {
  constructor(
    @Inject(EXTERNAL_INVOICE_REPOSITORY)
    private readonly repo: ExternalInvoiceRepository,
  ) {}

  async execute(
    paymentId: string,
    raw: string | null | undefined,
    ctx: AuditRequestContext,
  ): Promise<ExternalInvoiceNumberResult> {
    const value = normalizeReceiptText(raw, EXTERNAL_INVOICE_NUMBER_MAX);
    if (value === undefined) {
      throw new BadRequestException(EXTERNAL_INVOICE_NUMBER_MESSAGE);
    }
    const outcome = await this.repo.set(paymentId, value, ctx);
    if (outcome.kind === 'not-found') {
      throw new NotFoundException(PAYMENT_NOT_FOUND_MESSAGE);
    }
    if (outcome.kind === 'voided') {
      throw new ConflictException(EXTERNAL_INVOICE_VOIDED_MESSAGE);
    }
    return outcome.result;
  }
}
