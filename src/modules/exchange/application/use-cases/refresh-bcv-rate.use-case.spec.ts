import { Logger } from '@nestjs/common';
import type { BcvRateSnapshot } from '../../domain/bcv-rate';
import { ExchangeRateUnavailableError } from '../../domain/ports/exchange-rate-provider.port';
import { makeBcvRates } from '../__fixtures__/in-memory-exchange-settings';
import {
  BcvRateRejectedError,
  RefreshBcvRateUseCase,
} from './refresh-bcv-rate.use-case';

const fetchedAt = new Date('2026-11-21T19:00:00.000Z');
const published = (
  overrides: Partial<BcvRateSnapshot> = {},
): BcvRateSnapshot => ({
  usdVes: 918.7662,
  eurVes: 1011.17949056,
  valueDate: '2026-11-24',
  fetchedAt,
  origin: 'BCV',
  ...overrides,
});

describe('RefreshBcvRateUseCase (DX-585)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const useCase = (
    fetchLatest: () => Promise<BcvRateSnapshot>,
    repo = makeBcvRates(),
  ) => ({ repo, uc: new RefreshBcvRateUseCase({ fetchLatest }, repo) });

  it('una fecha valor nueva se guarda', async () => {
    const { repo, uc } = useCase(
      () => Promise.resolve(published()),
      makeBcvRates([
        { valueDate: '2026-11-20', usdVes: 917.62, eurVes: 1009.5 },
      ]),
    );
    await expect(uc.execute()).resolves.toEqual({
      kind: 'SAVED',
      snapshot: published(),
    });
    expect(repo.all().map((s) => s.valueDate)).toEqual([
      '2026-11-24',
      '2026-11-20',
    ]);
  });

  it('la misma fecha valor con la misma cifra: nada (idempotente)', async () => {
    const repo = makeBcvRates([
      {
        valueDate: '2026-11-24',
        usdVes: 918.7662,
        eurVes: 1011.17949056,
        fetchedAt: new Date('2026-11-20T21:00:00Z'),
      },
    ]);
    const upsert = jest.spyOn(repo, 'upsert');
    const { uc } = useCase(() => Promise.resolve(published()), repo);
    const outcome = await uc.execute();
    expect(outcome.kind).toBe('UNCHANGED');
    expect(upsert).not.toHaveBeenCalled();
    // La hora de consulta guardada no cambia.
    expect(repo.all()[0].fetchedAt).toEqual(new Date('2026-11-20T21:00:00Z'));
  });

  it('más decimales que la columna (el respaldo) cuentan como la misma cifra', async () => {
    const repo = makeBcvRates([
      { valueDate: '2026-11-24', usdVes: 918.7662, eurVes: 1011.17949056 },
    ]);
    const { uc } = useCase(
      () =>
        Promise.resolve(
          published({ usdVes: 918.766200001, origin: 'FALLBACK' }),
        ),
      repo,
    );
    expect((await uc.execute()).kind).toBe('UNCHANGED');
  });

  it('la misma fecha valor con otra cifra (corrección del BCV) se actualiza', async () => {
    const repo = makeBcvRates([
      { valueDate: '2026-11-24', usdVes: 918.5, eurVes: 1011 },
    ]);
    const { uc } = useCase(() => Promise.resolve(published()), repo);
    expect((await uc.execute()).kind).toBe('UPDATED');
    expect(repo.all()[0]).toMatchObject({
      usdVes: 918.7662,
      eurVes: 1011.17949056,
    });
  });

  it('una variación de 30 % o más no se guarda: aviso en el log y error para que el trabajo reintente', async () => {
    const repo = makeBcvRates([
      { valueDate: '2026-11-20', usdVes: 600, eurVes: 660 },
    ]);
    const { uc } = useCase(() => Promise.resolve(published()), repo);
    await expect(uc.execute()).rejects.toBeInstanceOf(BcvRateRejectedError);
    expect(repo.all()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'exchange.bcv_rate_rejected',
        reason: 'variación >= 30 % frente a la última guardada',
        previousValueDate: '2026-11-20',
      }),
    );
  });

  it('compara con la última hasta esa fecha valor, no con una posterior', async () => {
    // Una fecha valor posterior ya guardada (p. ej. de la víspera de un
    // feriado) no cuenta para validar la de antes.
    const repo = makeBcvRates([
      { valueDate: '2026-11-20', usdVes: 917.62, eurVes: 1009.5 },
      { valueDate: '2026-11-30', usdVes: 2000, eurVes: 2200 },
    ]);
    const { uc } = useCase(() => Promise.resolve(published()), repo);
    expect((await uc.execute()).kind).toBe('SAVED');
  });

  it('EUR/USD absurdo no se guarda', async () => {
    const { repo, uc } = useCase(() =>
      Promise.resolve(published({ eurVes: 101117949056 })),
    );
    await expect(uc.execute()).rejects.toThrow('EUR/USD fuera de rango');
    expect(repo.all()).toHaveLength(0);
  });

  it('sin tasa del BCV ni del respaldo: se propaga y no guarda nada', async () => {
    const { repo, uc } = useCase(() =>
      Promise.reject(new ExchangeRateUnavailableError('Sin tasa del BCV')),
    );
    await expect(uc.execute()).rejects.toBeInstanceOf(
      ExchangeRateUnavailableError,
    );
    expect(repo.all()).toHaveLength(0);
  });
});
