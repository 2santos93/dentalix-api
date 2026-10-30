import { BadRequestException } from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { EXCHANGE_RATE_SOURCE_MESSAGE } from '../../domain/exchange-rate-source';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { makeSettings } from '../__fixtures__/in-memory-exchange-settings';
import {
  GetExchangeRateSettingsUseCase,
  UpdateExchangeRateSettingsUseCase,
} from './exchange-rate-settings.use-cases';

describe('Fuente de la tasa de la clínica (DX-374)', () => {
  const TENANT = '55555555-5555-4555-8555-555555555555';
  const audit = { record: jest.fn() };
  const ctx: AuditRequestContext = {
    tenantId: TENANT,
    locationId: null,
    actor: { userId: 'u-admin', role: 'ADMIN' },
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  };
  const tenantContext = new TenantContextService();
  let settings: ReturnType<typeof makeSettings>;
  const update = () =>
    new UpdateExchangeRateSettingsUseCase(
      settings,
      audit as unknown as RecordAuditEventUseCase,
    );
  const inClinic = <T>(fn: () => Promise<T>) => tenantContext.run(TENANT, fn);

  beforeEach(() => {
    settings = makeSettings({}, tenantContext);
    audit.record.mockReset();
  });

  it('una clínica sin cambiar nada está en AUTOMATIC (lo de siempre)', async () => {
    await expect(
      inClinic(() => new GetExchangeRateSettingsUseCase(settings).execute()),
    ).resolves.toEqual({ source: 'AUTOMATIC' });
  });

  it('pasar a MANUAL lo guarda y lo audita como CLINIC_SETTINGS con el antes y el después', async () => {
    await expect(
      inClinic(() => update().execute({ source: 'MANUAL' }, ctx)),
    ).resolves.toEqual({ source: 'MANUAL' });
    expect(settings.sourceOf(TENANT)).toBe('MANUAL');
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: TENANT,
      locationId: null,
      actor: { kind: 'user', userId: 'u-admin', role: 'ADMIN' },
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: null,
      patient: null,
      requestId: 'req-1',
      ip: null,
      userAgent: null,
      metadata: {
        reason: 'EXCHANGE_RATE_SOURCE',
        statusChange: { from: 'AUTOMATIC', to: 'MANUAL' },
      },
    });
  });

  it('si la fuente no cambia responde igual y no deja evento', async () => {
    await expect(
      inClinic(() => update().execute({ source: 'AUTOMATIC' }, ctx)),
    ).resolves.toEqual({ source: 'AUTOMATIC' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('una fuente desconocida es 400 en español y no escribe', async () => {
    const run = inClinic(() =>
      update().execute({ source: 'PROVIDER' as never }, ctx),
    );
    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow(EXCHANGE_RATE_SOURCE_MESSAGE);
    expect(settings.sourceOf(TENANT)).toBe('AUTOMATIC');
    expect(audit.record).not.toHaveBeenCalled();
  });
});
