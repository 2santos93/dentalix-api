import { Injectable } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { FrozenExchangeRate } from '../domain/payment-exchange-rate';

/**
 * DX-402: deja en la auditoría que un abono congeló como tasa de respaldo la
 * tasa manual de un día anterior a `manualSince` (un día sin tasa del
 * proveedor). Lo escribe el barrido, sin usuario (`system`, origen JOB): la
 * BD solo admite ese evento sin actor (audit_events_actor_check). Lleva el
 * día de la tasa, desde cuándo rige la manual y las monedas; ni importes ni
 * la tasa, que van en el abono. Como todo evento, `record` nunca lanza.
 */
@Injectable()
export class PaymentRateBackupAudit {
  constructor(
    private readonly audit: RecordAuditEventUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  async backupRateUsed(
    paymentId: string,
    rate: FrozenExchangeRate,
    paymentCurrency: string,
  ): Promise<void> {
    const tenantId = this.tenantContext.getTenantId();
    if (!rate.backup || tenantId === undefined) return;
    await this.audit.record({
      tenantId,
      locationId: null,
      actor: { kind: 'system' },
      action: 'UPDATE',
      resourceType: 'PAYMENT',
      resourceId: paymentId,
      patient: { kind: 'payment', id: paymentId },
      requestId: null,
      ip: null,
      userAgent: null,
      metadata: {
        reason: 'EXCHANGE_RATE_BACKUP',
        origin: 'JOB',
        exchangeRateBackup: {
          rateDate: rate.date,
          manualSince: rate.backup.manualSince,
          currencies: [...new Set([rate.currency, paymentCurrency])].sort(),
        },
      },
    });
  }
}
