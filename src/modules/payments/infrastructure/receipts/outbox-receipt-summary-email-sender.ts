import { Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../../notifications/email/application/email-outbox.service';
import { withEmailQuotaAs429 } from '../../../notifications/email/application/email-quota-http';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { resolveLocationRegional } from '../../../../shared/locations/location-regional';
import { readCurrencyTexts } from '../../../../shared/format/currency-text';
import type { ReceiptSummaryEmailSender } from '../../domain/ports/receipt-summary-email-sender.port';
import type { PaymentReceiptSummaryView } from '../../domain/receipt-summary';
import { receiptSummaryEmailVars } from '../../application/receipts/receipt-summary-email-vars';

/**
 * DX-401: encola el resumen de abonos en el outbox de email (DX-088), como el
 * recibo de un abono: antes, los topes de la clínica y del destinatario; al
 * encolar, de nuevo bajo su candado (DX-149-ter). Pasarlos es un 429 en
 * español. `referenceId` = el paciente (el resumen no es una fila propia).
 */
@Injectable()
export class OutboxReceiptSummaryEmailSender implements ReceiptSummaryEmailSender {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  async send(
    to: string,
    summary: PaymentReceiptSummaryView,
    locationId: string,
    responsibleName: string | null,
  ): Promise<void> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    await withEmailQuotaAs429(() =>
      this.outbox.assertWithinQuota(tenantId, to, 'payment-receipt-summary'),
    );
    const { fmt, currencyTexts } = await this.prisma.runWithTenant(
      async (tx) => {
        const [regionalOf, tenant] = await Promise.all([
          resolveLocationRegional(tx, tenantId, [locationId]),
          tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { currencyTexts: true },
          }),
        ]);
        return {
          fmt: regionalOf(locationId).fmt,
          currencyTexts: readCurrencyTexts(tenant.currencyTexts),
        };
      },
    );
    await withEmailQuotaAs429(() =>
      this.outbox.enqueue({
        tenantId,
        to,
        template: 'payment-receipt-summary',
        vars: {
          ...receiptSummaryEmailVars(summary, fmt, currencyTexts),
          responsibleName,
        },
        referenceId: summary.patient.id,
        enforceQuota: true,
      }),
    );
  }
}
