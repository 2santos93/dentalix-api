import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { ExchangeRateSource } from '../../domain/exchange-rate-source';
import type { ClinicExchangeSettingsRepository } from '../../domain/ports/clinic-exchange-settings-repository.port';
import type { ClinicCurrenciesRepository } from '../../domain/ports/clinic-currencies-repository.port';
import {
  EXCHANGE_REFRESH_COOLDOWN_SECONDS,
  type ExchangeRefreshCooldown,
  type RefreshClaim,
} from '../../domain/ports/exchange-refresh-cooldown.port';
import { ExchangeRateUnavailableError } from '../../domain/ports/exchange-rate-provider.port';
import type { ExchangeSourceChangeHooks } from '../exchange-source-change-hooks';
import type {
  ExchangeHeader,
  GetExchangeHeaderUseCase,
} from './get-exchange-header.use-case';
import type { GetRatesForDateUseCase } from './get-rates-for-date.use-case';
import {
  BcvRateRejectedError,
  type RefreshBcvRateUseCase,
} from './refresh-bcv-rate.use-case';
import {
  EXCHANGE_REFRESH_MANUAL_MESSAGE,
  ExchangeRefreshTooSoonError,
  RefreshExchangeRateUseCase,
  refreshTooSoonMessage,
} from './refresh-exchange-rate.use-case';

const TENANT = '58658658-6586-4586-8586-586586586586';
// 2026-11-21 02:00 UTC: en Caracas (UTC−4) aún es el 20.
const NOW = new Date('2026-11-21T02:00:00.000Z');
const ctx: AuditRequestContext = {
  tenantId: TENANT,
  locationId: null,
  actor: { userId: 'u-recepcion', role: 'RECEPTION' },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};
const HEADER: ExchangeHeader = {
  visible: true,
  reference: 'VES',
  referenceLabel: 'Bs.',
  rates: [],
  acceptedCurrencies: ['USD', 'VES'],
  updatedAt: NOW.toISOString(),
};

function setup(source: ExchangeRateSource, claim: RefreshClaim = { ok: true }) {
  const settings = {
    get: jest.fn(() =>
      Promise.resolve({ source, manualSince: null, manualRateMaxAgeDays: 3 }),
    ),
    principalTimeZone: jest.fn(() => Promise.resolve('UTC')),
  };
  const currencies = {
    headerLocation: jest.fn(() =>
      Promise.resolve({ timeZone: 'America/Caracas', currency: 'VES' }),
    ),
  };
  const cooldown = { claim: jest.fn(() => Promise.resolve(claim)) };
  const refreshBcv = { execute: jest.fn(() => Promise.resolve({})) };
  const rates = { refreshProviderRates: jest.fn(() => Promise.resolve({})) };
  const header = { execute: jest.fn(() => Promise.resolve(HEADER)) };
  const hooks = { afterRatesChange: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const uc = new RefreshExchangeRateUseCase(
    settings as unknown as ClinicExchangeSettingsRepository,
    currencies as unknown as ClinicCurrenciesRepository,
    cooldown as ExchangeRefreshCooldown,
    refreshBcv as unknown as RefreshBcvRateUseCase,
    rates as unknown as GetRatesForDateUseCase,
    header as unknown as GetExchangeHeaderUseCase,
    hooks as unknown as ExchangeSourceChangeHooks,
    audit as unknown as RecordAuditEventUseCase,
    () => NOW,
  );
  return { uc, cooldown, refreshBcv, rates, header, hooks, audit };
}

describe('RefreshExchangeRateUseCase (DX-586)', () => {
  it('con BCV vuelve a consultar el BCV, reintenta los abonos sin tasa, audita y devuelve el indicador', async () => {
    const s = setup('BCV');
    await expect(s.uc.execute(ctx)).resolves.toBe(HEADER);
    expect(s.cooldown.claim).toHaveBeenCalledWith(
      EXCHANGE_REFRESH_COOLDOWN_SECONDS,
    );
    expect(s.refreshBcv.execute).toHaveBeenCalledTimes(1);
    expect(s.rates.refreshProviderRates).not.toHaveBeenCalled();
    expect(s.hooks.afterRatesChange).toHaveBeenCalledTimes(1);
    expect(s.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: TENANT,
        metadata: { reason: 'EXCHANGE_RATE_REFRESH' },
      }),
    );
  });

  it('con AUTOMATIC vuelve a pedir al proveedor las de hoy en la sede (Caracas)', async () => {
    const s = setup('AUTOMATIC');
    await s.uc.execute(ctx);
    expect(s.rates.refreshProviderRates).toHaveBeenCalledWith('2026-11-20');
    expect(s.refreshBcv.execute).not.toHaveBeenCalled();
  });

  it('con MANUAL: 409 y no gasta el turno', async () => {
    const s = setup('MANUAL');
    const error = await s.uc.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'EXCHANGE_RATE_REFRESH_MANUAL',
      message: EXCHANGE_REFRESH_MANUAL_MESSAGE,
    });
    expect(s.cooldown.claim).not.toHaveBeenCalled();
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('antes de 5 min: «Vuelve a intentarlo en N min» sin consultar nada', async () => {
    const s = setup('BCV', { ok: false, retryAfterSeconds: 181 });
    const error = await s.uc.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExchangeRefreshTooSoonError);
    expect((error as ExchangeRefreshTooSoonError).response()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'EXCHANGE_RATE_REFRESH_TOO_SOON',
      message: 'Vuelve a intentarlo en 4 min.',
      retryAfterSeconds: 181,
    });
    expect(s.refreshBcv.execute).not.toHaveBeenCalled();
  });

  it('el BCV y su respaldo caídos: se propaga (503 en la ruta) y no audita', async () => {
    const s = setup('BCV');
    s.refreshBcv.execute.mockRejectedValueOnce(
      new ExchangeRateUnavailableError('caído'),
    );
    await expect(s.uc.execute(ctx)).rejects.toBeInstanceOf(
      ExchangeRateUnavailableError,
    );
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('una tasa del BCV que no pasa la cordura: 503 EXCHANGE_RATE_BCV_REJECTED', async () => {
    const s = setup('BCV');
    s.refreshBcv.execute.mockRejectedValueOnce(
      new BcvRateRejectedError('variación'),
    );
    const error = await s.uc.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'EXCHANGE_RATE_BCV_REJECTED',
    });
  });

  it('el mensaje redondea los minutos hacia arriba y nunca dice 0', () => {
    expect(refreshTooSoonMessage(1)).toBe('Vuelve a intentarlo en 1 min.');
    expect(refreshTooSoonMessage(300)).toBe('Vuelve a intentarlo en 5 min.');
  });
});
