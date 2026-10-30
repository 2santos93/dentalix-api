import { PaymentRateBackupAudit } from './payment-rate-backup-audit';
import type { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '22222222-2222-4222-8222-222222222222';

function setup() {
  const drafts: AuditEventDraft[] = [];
  const audit = {
    record: (draft: AuditEventDraft) => {
      drafts.push(draft);
      return Promise.resolve();
    },
  } as unknown as RecordAuditEventUseCase;
  const tenantContext = new TenantContextService();
  return {
    drafts,
    tenantContext,
    service: new PaymentRateBackupAudit(audit, tenantContext),
  };
}

describe('PaymentRateBackupAudit (DX-402)', () => {
  it('deja un evento del barrido en el abono con el día de la tasa y desde cuándo rige la manual', async () => {
    const { drafts, tenantContext, service } = setup();
    await tenantContext.run(TENANT, () =>
      service.backupRateUsed(
        PAYMENT,
        {
          currency: 'COP',
          fromPerBase: 1,
          toPerBase: 4000,
          source: 'MANUAL',
          date: '2026-10-28',
          backup: { manualSince: '2026-10-30' },
        },
        'USD',
      ),
    );
    expect(drafts).toEqual([
      {
        tenantId: TENANT,
        locationId: null,
        actor: { kind: 'system' },
        action: 'UPDATE',
        resourceType: 'PAYMENT',
        resourceId: PAYMENT,
        patient: { kind: 'payment', id: PAYMENT },
        requestId: null,
        ip: null,
        userAgent: null,
        metadata: {
          reason: 'EXCHANGE_RATE_BACKUP',
          origin: 'JOB',
          exchangeRateBackup: {
            rateDate: '2026-10-28',
            manualSince: '2026-10-30',
            currencies: ['COP', 'USD'],
          },
        },
      },
    ]);
  });

  it('sin respaldo o sin clínica en el contexto no escribe nada', async () => {
    const { drafts, tenantContext, service } = setup();
    const rate = {
      currency: 'COP',
      fromPerBase: 1,
      toPerBase: 4000,
      source: 'MANUAL' as const,
      date: '2026-10-28',
    };
    await tenantContext.run(TENANT, () =>
      service.backupRateUsed(PAYMENT, rate, 'USD'),
    );
    await service.backupRateUsed(
      PAYMENT,
      { ...rate, backup: { manualSince: '2026-10-30' } },
      'USD',
    );
    expect(drafts).toEqual([]);
  });
});
