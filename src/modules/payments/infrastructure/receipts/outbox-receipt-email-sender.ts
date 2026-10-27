import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../../notifications/email/application/email-outbox.service';
import { EmailQuotaExceededError } from '../../../notifications/email/domain/email-quota-exceeded.error';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { resolveLocationRegional } from '../../../../shared/locations/location-regional';
import type { ReceiptEmailSender } from '../../domain/ports/receipt-email-sender.port';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';
import { receiptEmailVars } from '../../application/receipts/receipt-email-vars';

/**
 * Envía el recibo por el outbox de email (DX-088): lo encola cifrado y
 * vuelve; el despachador lo entrega. Antes, los topes de la clínica y del
 * destinatario (contados en la BD): pasarlos es un 429 en español.
 */
@Injectable()
export class OutboxReceiptEmailSender implements ReceiptEmailSender {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  async send(
    to: string,
    receipt: PaymentReceiptView,
    responsibleName: string | null = null,
  ): Promise<void> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    try {
      await this.outbox.assertWithinQuota(tenantId, to);
    } catch (err) {
      if (err instanceof EmailQuotaExceededError) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
    // Las fechas del email, en días civiles de la sede del recibo (DX-097),
    // y fechas e importes con su formato ACTUAL, como la zona (G1-B).
    const locationId = receipt.snapshot.location.id;
    const regionalOf = await this.prisma.runWithTenant((tx) =>
      resolveLocationRegional(tx, tenantId, [locationId]),
    );
    const { timeZone, fmt } = regionalOf(locationId);
    await this.outbox.enqueue({
      tenantId,
      to,
      template: 'payment-receipt',
      vars: {
        ...receiptEmailVars(receipt, timeZone, fmt),
        responsibleName,
      },
      referenceId: receipt.paymentId,
    });
  }
}
