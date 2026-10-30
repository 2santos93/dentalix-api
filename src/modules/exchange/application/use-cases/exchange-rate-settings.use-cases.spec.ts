import { BadRequestException } from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { EXCHANGE_RATE_SOURCE_MESSAGE } from '../../domain/exchange-rate-source';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { makeSettings } from '../__fixtures__/in-memory-exchange-settings';
import { ExchangeSourceChangeHooks } from '../exchange-source-change-hooks';
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
  let hooks: ExchangeSourceChangeHooks;
  const update = () =>
    new UpdateExchangeRateSettingsUseCase(
      settings,
      audit as unknown as RecordAuditEventUseCase,
      () => now,
      hooks,
    );
  const inClinic = <T>(fn: () => Promise<T>) => tenantContext.run(TENANT, fn);

  beforeEach(() => {
    hooks = new ExchangeSourceChangeHooks();
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

  // DX-380: después de cambiar la fuente (ya guardada) se adelantan los
  // reintentos de los abonos sin tasa; si no cambia, nada.
  it('tras cambiar la fuente avisa de que cambiaron las tasas, y solo si cambia', async () => {
    const seen: string[] = [];
    hooks.registerAfterRatesChange(() => {
      seen.push(settings.settingsOf(TENANT).source);
      return Promise.resolve();
    });
    await inClinic(() => update().execute({ source: 'AUTOMATIC' }, ctx));
    await inClinic(() => update().execute({ source: 'MANUAL' }, ctx));

    expect(seen).toEqual(['MANUAL']);
  });

  it('un fallo al avisar no deshace el cambio de fuente', async () => {
    hooks.registerAfterRatesChange(() => Promise.reject(new Error('caída')));
    await expect(
      inClinic(() => update().execute({ source: 'MANUAL' }, ctx)),
    ).resolves.toMatchObject({ source: 'MANUAL' });
  });

  // BE-047 (DX-375): antes de cambiar la fuente se congela la tasa de los
  // abonos que la esperaban, con la fuente de ANTES: ningún abono ya cobrado
  // cambia de tasa por el cambio.
  it('congela los abonos pendientes ANTES de cambiar la fuente, y solo si cambia (BE-047)', async () => {
    const order: string[] = [];
    hooks.register(() => {
      order.push(`hook:${settings.settingsOf(TENANT).source}`);
      return Promise.resolve();
    });
    await inClinic(() => update().execute({ source: 'MANUAL' }, ctx));
    expect(order).toEqual(['hook:AUTOMATIC']);
    await inClinic(() => update().execute({ source: 'MANUAL' }, ctx));
    expect(order).toEqual(['hook:AUTOMATIC']);
    await inClinic(() => update().execute({ source: 'AUTOMATIC' }, ctx));
    expect(order).toEqual(['hook:AUTOMATIC', 'hook:MANUAL']);
  });

  it('si congelar falla, la fuente no cambia', async () => {
    hooks.register(() => Promise.reject(new Error('BD caída')));
    await expect(
      inClinic(() => update().execute({ source: 'MANUAL' }, ctx)),
    ).rejects.toThrow('BD caída');
    expect(settings.settingsOf(TENANT).source).toBe('AUTOMATIC');
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
