import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../../notifications/email/application/email-outbox.service';
import { EmailQuotaExceededError } from '../../../notifications/email/domain/email-quota-exceeded.error';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  locationRegionalOrNull,
  resolveLocationRegional,
  type LocationRegional,
} from '../../../../shared/locations/location-regional';
import { regionalFormat } from '../../../../shared/format/regional-format';
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
    const { timeZone, fmt } = await this.regionalOf(tenantId, receipt);
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

  /**
   * Las fechas del email, en días civiles de la sede del recibo (DX-097), y
   * fechas e importes con su formato (G1-B). DX-521: el del recibo
   * (`receipt.regional`: el congelado al emitir, o el de hoy de la sede) si
   * este runtime lo reconoce; si es `null` o no lo reconoce, el camino de
   * antes: los ajustes ACTUALES de la sede, con su 409 si faltan.
   */
  private async regionalOf(
    tenantId: string,
    receipt: PaymentReceiptView,
  ): Promise<LocationRegional> {
    const frozen = locationRegionalOrNull(receipt.regional);
    if (frozen) {
      return {
        timeZone: frozen.timeZone,
        fmt: regionalFormat({
          locale: frozen.locale,
          hourCycle: frozen.hourCycle,
        }),
      };
    }
    const locationId = receipt.snapshot.location.id;
    const regionalOf = await this.prisma.runWithTenant((tx) =>
      resolveLocationRegional(tx, tenantId, [locationId]),
    );
    return regionalOf(locationId);
  }
}
