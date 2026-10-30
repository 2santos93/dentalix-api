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
  // 2026-10-30 03:00 UTC: en la sede principal (UTC-4) aún es el 29.
  const NOW = new Date(Date.UTC(2026, 9, 30, 3, 0));
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
  let now: Date;
  const update = () =>
    new UpdateExchangeRateSettingsUseCase(
      settings,
      audit as unknown as RecordAuditEventUseCase,
      () => now,
    );
  const inClinic = <T>(fn: () => Promise<T>) => tenantContext.run(TENANT, fn);

  beforeEach(() => {
    now = NOW;
    settings = makeSettings({}, tenantContext, {
      zones: { [TENANT]: 'America/Caracas' },
    });
    audit.record.mockReset();
  });

  it('una clínica sin cambiar nada está en AUTOMATIC, sin día de inicio, con la moneda base', async () => {
    await expect(
      inClinic(() => new GetExchangeRateSettingsUseCase(settings).execute()),
    ).resolves.toEqual({
      source: 'AUTOMATIC',
      manualSince: null,
      baseCurrency: 'USD',
    });
  });

  it('pasar a MANUAL fija el día de hoy en la sede principal y lo audita con el antes y el después', async () => {
    await expect(
      inClinic(() => update().execute({ source: 'MANUAL' }, ctx)),
    ).resolves.toEqual({
      source: 'MANUAL',
      manualSince: '2026-10-29',
      baseCurrency: 'USD',
    });
    expect(settings.settingsOf(TENANT)).toEqual({
      source: 'MANUAL',
      manualSince: '2026-10-29',
    });
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

  it('guardar MANUAL otra vez otro día conserva el día de inicio y no deja evento', async () => {
    await inClinic(() => update().execute({ source: 'MANUAL' }, ctx));
    audit.record.mockReset();
    now = new Date(Date.UTC(2026, 10, 5, 15, 0));
    await expect(
      inClinic(() => update().execute({ source: 'MANUAL' }, ctx)),
    ).resolves.toMatchObject({ manualSince: '2026-10-29' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('volver a AUTOMATIC limpia el día de inicio', async () => {
    await inClinic(() => update().execute({ source: 'MANUAL' }, ctx));
    await expect(
      inClinic(() => update().execute({ source: 'AUTOMATIC' }, ctx)),
    ).resolves.toMatchObject({ source: 'AUTOMATIC', manualSince: null });
    expect(settings.settingsOf(TENANT).manualSince).toBeNull();
  });

  it('si la fuente no cambia responde igual y no deja evento', async () => {
    await expect(
      inClinic(() => update().execute({ source: 'AUTOMATIC' }, ctx)),
    ).resolves.toMatchObject({ source: 'AUTOMATIC' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('una fuente desconocida es 400 en español y no escribe', async () => {
    const run = inClinic(() =>
      update().execute({ source: 'PROVIDER' as never }, ctx),
    );
    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow(EXCHANGE_RATE_SOURCE_MESSAGE);
    expect(settings.settingsOf(TENANT).source).toBe('AUTOMATIC');
    expect(audit.record).not.toHaveBeenCalled();
  });
});
