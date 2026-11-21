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

describe('RefreshBcvRateUseCase · arranque en frío (DX-586)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // Sábado 21/11 a las 15:00 de Caracas: el BCV ya publica la del martes 24.
  const now = () => new Date('2026-11-21T19:00:00.000Z');
  const vigente = (overrides: Partial<BcvRateSnapshot> = {}) =>
    published({
      valueDate: '2026-11-20',
      usdVes: 917.62,
      eurVes: 1009.5,
      origin: 'FALLBACK',
      ...overrides,
    });
  const useCase = (
    fetchFallback: (() => Promise<BcvRateSnapshot>) | undefined,
    repo = makeBcvRates(),
  ) => {
    const fallback = fetchFallback ? jest.fn(fetchFallback) : undefined;
    return {
      repo,
      fallback,
      uc: new RefreshBcvRateUseCase(
        {
          fetchLatest: () => Promise.resolve(published()),
          ...(fallback ? { fetchFallback: fallback } : {}),
        },
        repo,
        now,
      ),
    };
  };

  it('sin tasa guardada y fecha valor futura: guarda también la vigente de hoy del respaldo (FALLBACK)', async () => {
    const { repo, uc, fallback } = useCase(() => Promise.resolve(vigente()));
    await expect(uc.execute()).resolves.toMatchObject({ kind: 'SAVED' });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(repo.all().map((s) => [s.valueDate, s.origin])).toEqual([
      ['2026-11-24', 'BCV'],
      ['2026-11-20', 'FALLBACK'],
    ]);
  });

  it('con una tasa que ya cubre hoy no consulta el respaldo', async () => {
    const { repo, uc, fallback } = useCase(
      () => Promise.resolve(vigente()),
      makeBcvRates([
        { valueDate: '2026-11-20', usdVes: 917.62, eurVes: 1009.5 },
      ]),
    );
    await uc.execute();
    expect(fallback).not.toHaveBeenCalled();
    expect(repo.all()).toHaveLength(2);
  });

  it('si el respaldo también trae una fecha futura, no guarda nada más', async () => {
    const { repo, uc } = useCase(() =>
      Promise.resolve(vigente({ valueDate: '2026-11-24' })),
    );
    await uc.execute();
    expect(repo.all().map((s) => s.valueDate)).toEqual(['2026-11-24']);
  });

  it('si el respaldo falla, la consulta no falla y guarda la publicada', async () => {
    const { repo, uc } = useCase(() =>
      Promise.reject(new ExchangeRateUnavailableError('caído')),
    );
    await expect(uc.execute()).resolves.toMatchObject({ kind: 'SAVED' });
    expect(repo.all().map((s) => s.valueDate)).toEqual(['2026-11-24']);
  });

  it('la publicada se compara (cordura) con la vigente recién guardada', async () => {
    const { uc } = useCase(() =>
      Promise.resolve(vigente({ usdVes: 500, eurVes: 550 })),
    );
    // 918,77 frente a 500: variación > 30 %: la publicada se rechaza.
    await expect(uc.execute()).rejects.toBeInstanceOf(BcvRateRejectedError);
  });
});
