import { BadRequestException } from '@nestjs/common';
import {
  ConvertAmountUseCase,
  convertWithQuote,
} from './convert-amount.use-case';
import { GetRatesForDateUseCase } from './get-rates-for-date.use-case';
import { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import { ExchangeRateProvider } from '../../domain/ports/exchange-rate-provider.port';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';
import { MissingExchangeRateError } from '../../domain/missing-exchange-rate.error';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  makeManualRates,
  makeSettings,
} from '../__fixtures__/in-memory-exchange-settings';

/** Sin tenant en el contexto: lectura del proveedor, como antes de DX-374. */
function ratesUseCase(
  repo: ExchangeRateRepository,
  provider: ExchangeRateProvider,
): GetRatesForDateUseCase {
  return new GetRatesForDateUseCase(
    repo,
    provider,
    makeSettings({}),
    makeManualRates({}),
    new TenantContextService(),
  );
}

const DATE = '2026-07-22';

/**
 * A repo pre-seeded with rates for DATE and a provider that throws if ever
 * called — proves ConvertAmount goes through the cache (GetRatesForDate's
 * cache-then-fetch), never hitting the external provider when a snapshot
 * already exists.
 */
function makeSeededUseCase(
  rates: Record<string, number>,
): ConvertAmountUseCase {
  const snapshots: ExchangeRateSnapshot[] = Object.entries(rates).map(
    ([currency, rate]) => ({
      id: `${DATE}:${currency}`,
      date: DATE,
      currency,
      rate,
      fetchedAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
  );

  const repo: ExchangeRateRepository = {
    findByDate: (date: string) =>
      Promise.resolve(date === DATE ? snapshots : []),
    upsertMany: () => Promise.reject(new Error('should not be called')),
  };
  const provider: ExchangeRateProvider = {
    fetchRates: () =>
      Promise.reject(new Error('provider should not be called on a cache hit')),
  };

  const getRatesForDate = ratesUseCase(repo, provider);
  return new ConvertAmountUseCase(getRatesForDate);
}

describe('ConvertAmountUseCase', () => {
  it('converts USD -> COP using the base rate directly', async () => {
    const uc = makeSeededUseCase({ COP: 4000 });

    const result = await uc.execute({
      amount: 100,
      from: 'USD',
      to: 'COP',
      date: DATE,
    });

    expect(result).toEqual({
      amount: 100,
      from: 'USD',
      to: 'COP',
      date: DATE,
      result: 400000,
      rateUsed: 4000,
    });
  });

  it('converts COP -> USD (division by the base rate)', async () => {
    const uc = makeSeededUseCase({ COP: 4000 });

    const result = await uc.execute({
      amount: 400000,
      from: 'COP',
      to: 'USD',
      date: DATE,
    });

    expect(result.result).toBe(100);
    expect(result.rateUsed).toBeCloseTo(0.00025, 10);
  });

  it('converts COP -> EUR via USD (cross-rate through the base)', async () => {
    const uc = makeSeededUseCase({ COP: 4000, EUR: 0.92 });

    const result = await uc.execute({
      amount: 4000,
      from: 'COP',
      to: 'EUR',
      date: DATE,
    });

    // 4000 COP -> 1 USD -> 0.92 EUR
    expect(result.result).toBe(0.92);
  });

  it('returns the amount unchanged when from === to, with rateUsed 1 (no rates lookup needed)', async () => {
    const uc = makeSeededUseCase({}); // empty: would 400 on any real lookup

    const result = await uc.execute({
      amount: 123.45,
      from: 'COP',
      to: 'COP',
      date: DATE,
    });

    expect(result).toEqual({
      amount: 123.45,
      from: 'COP',
      to: 'COP',
      date: DATE,
      result: 123.45,
      rateUsed: 1,
    });
  });

  it('rejects an unknown/unsupported currency with BadRequestException', async () => {
    const uc = makeSeededUseCase({ COP: 4000 });

    await expect(
      uc.execute({ amount: 10, from: 'USD', to: 'ZZZ', date: DATE }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      uc.execute({ amount: 10, from: 'ZZZ', to: 'USD', date: DATE }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([-1, -0.01, NaN, Infinity, -Infinity])(
    'rejects an invalid amount (%s) with BadRequestException',
    async (amount) => {
      const uc = makeSeededUseCase({ COP: 4000 });

      await expect(
        uc.execute({ amount, from: 'USD', to: 'COP', date: DATE }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(['2026-7-22', '07-22-2026', 'not-a-date', ''])(
    'rejects an invalid date format (%s) with BadRequestException',
    async (date) => {
      const uc = makeSeededUseCase({ COP: 4000 });

      await expect(
        uc.execute({ amount: 10, from: 'USD', to: 'COP', date }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('rounds the result to 2 decimal places', async () => {
    const uc = makeSeededUseCase({ COP: 3891.23456 });

    const result = await uc.execute({
      amount: 10,
      from: 'USD',
      to: 'COP',
      date: DATE,
    });

    // 10 * 3891.23456 = 38912.3456 -> rounds to 38912.35
    expect(result.result).toBe(38912.35);
  });

  it('amount 0 does not divide by zero: rateUsed falls back to the unrounded from->to factor', async () => {
    const uc = makeSeededUseCase({ COP: 4000, EUR: 0.92 });

    const result = await uc.execute({
      amount: 0,
      from: 'COP',
      to: 'EUR',
      date: DATE,
    });

    expect(result.result).toBe(0);
    expect(result.rateUsed).toBeCloseTo(0.92 / 4000, 10);
  });

  it('does not touch the repository/provider at all when from === to (validated before any lookup)', async () => {
    const repo: ExchangeRateRepository = {
      findByDate: () => Promise.reject(new Error('should not be called')),
      upsertMany: () => Promise.reject(new Error('should not be called')),
    };
    const provider: ExchangeRateProvider = {
      fetchRates: () => Promise.reject(new Error('should not be called')),
    };
    const uc = new ConvertAmountUseCase(ratesUseCase(repo, provider));

    const result = await uc.execute({
      amount: 50,
      from: 'USD',
      to: 'USD',
      date: DATE,
    });

    expect(result.result).toBe(50);
    expect(result.rateUsed).toBe(1);
  });

  // DX-374: con la fuente MANUAL, la moneda sin tasa del día es un error de
  // dominio en español, sin pasar por el proveedor.
  describe('clínica con tasa manual (DX-374)', () => {
    const TENANT = '33333333-3333-4333-8333-333333333333';

    function manualUseCase() {
      const tenantContext = new TenantContextService();
      const fetchRates = jest.fn();
      const repo: ExchangeRateRepository = {
        findByDate: () => Promise.reject(new Error('no debe leer la caché')),
        upsertMany: () =>
          Promise.reject(new Error('no debe escribir la caché')),
      };
      const uc = new ConvertAmountUseCase(
        new GetRatesForDateUseCase(
          repo,
          { fetchRates },
          makeSettings({ [TENANT]: 'MANUAL' }, tenantContext),
          makeManualRates({ [TENANT]: { [DATE]: { VES: 40 } } }, tenantContext),
          tenantContext,
        ),
      );
      return { uc, fetchRates, tenantContext };
    }

    it('convierte con la tasa manual del día', async () => {
      const { uc, tenantContext } = manualUseCase();
      const out = await tenantContext.run(TENANT, () =>
        uc.execute({ amount: 400, from: 'VES', to: 'USD', date: DATE }),
      );
      expect(out.result).toBe(10);
    });

    it('sin tasa de la moneda ese día lanza MissingExchangeRateError y no llama al proveedor', async () => {
      const { uc, tenantContext, fetchRates } = manualUseCase();
      const run = tenantContext.run(TENANT, () =>
        uc.execute({ amount: 100, from: 'USD', to: 'EUR', date: DATE }),
      );
      await expect(run).rejects.toBeInstanceOf(MissingExchangeRateError);
      await expect(run).rejects.toThrow(
        'No hay tasa de EUR para el día 2026-07-22: la clínica usa tasa manual y aún no la registró.',
      );
      expect(fetchRates).not.toHaveBeenCalled();
    });
  });

  // DX-375: la cotización que congela un abono: las dos tasas por 1 USD tal
  // como las dio la fuente, la fuente y el día. Convertir con ella da lo
  // mismo, céntimo a céntimo, que `execute`.
  describe('quote (DX-375)', () => {
    const TENANT = '44444444-4444-4444-8444-444444444444';

    it('devuelve las tasas por 1 USD de las dos monedas y la fuente automática', async () => {
      const uc = makeSeededUseCase({ COP: 4000, EUR: 0.9 });
      await expect(
        uc.quote({ from: 'COP', to: 'EUR', date: DATE }),
      ).resolves.toEqual({
        from: 'COP',
        to: 'EUR',
        date: DATE,
        source: 'AUTOMATIC',
        fromPerBase: 4000,
        toPerBase: 0.9,
      });
    });

    it('la moneda base vale 1 y no se busca', async () => {
      const uc = makeSeededUseCase({ COP: 4000 });
      await expect(
        uc.quote({ from: 'USD', to: 'COP', date: DATE }),
      ).resolves.toMatchObject({ fromPerBase: 1, toPerBase: 4000 });
    });

    it('con tasa manual la fuente es MANUAL y una moneda sin tasa lanza MissingExchangeRateError', async () => {
      const tenantContext = new TenantContextService();
      const repo: ExchangeRateRepository = {
        findByDate: () => Promise.reject(new Error('no debe leer la caché')),
        upsertMany: () =>
          Promise.reject(new Error('no debe escribir la caché')),
      };
      const uc = new ConvertAmountUseCase(
        new GetRatesForDateUseCase(
          repo,
          { fetchRates: jest.fn() },
          makeSettings({ [TENANT]: 'MANUAL' }, tenantContext),
          makeManualRates({ [TENANT]: { [DATE]: { VES: 40 } } }, tenantContext),
          tenantContext,
        ),
      );
      await expect(
        tenantContext.run(TENANT, () =>
          uc.quote({ from: 'VES', to: 'USD', date: DATE }),
        ),
      ).resolves.toMatchObject({ source: 'MANUAL', fromPerBase: 40 });
      await expect(
        tenantContext.run(TENANT, () =>
          uc.quote({ from: 'COP', to: 'USD', date: DATE }),
        ),
      ).rejects.toBeInstanceOf(MissingExchangeRateError);
    });

    it('convertWithQuote da el mismo resultado que execute', async () => {
      const uc = makeSeededUseCase({ COP: 3950.5, EUR: 0.91234567 });
      const quote = await uc.quote({ from: 'COP', to: 'EUR', date: DATE });
      for (const amount of [1, 2, 5, 7, 100, 333, 1234567.89]) {
        const { result } = await uc.execute({
          amount,
          from: 'COP',
          to: 'EUR',
          date: DATE,
        });
        expect(convertWithQuote(amount, quote)).toBe(result);
      }
    });

    describe('tasa de respaldo de un día anterior a manual (DX-402)', () => {
      const SINCE = '2026-10-30';
      const DAY = '2026-10-28';

      function backupUseCase(fetchRates: ExchangeRateProvider['fetchRates']) {
        const tenantContext = new TenantContextService();
        const uc = new ConvertAmountUseCase(
          new GetRatesForDateUseCase(
            {
              findByDate: () => Promise.resolve([]),
              upsertMany: () => Promise.resolve(),
            },
            { fetchRates },
            makeSettings(
              { [TENANT]: { source: 'MANUAL', manualSince: SINCE } },
              tenantContext,
            ),
            makeManualRates(
              { [TENANT]: { [DAY]: { COP: 4000 } } },
              tenantContext,
            ),
            tenantContext,
          ),
        );
        return { uc, tenantContext };
      }

      it('la cotización con la tasa de respaldo es MANUAL y dice desde qué día rige la manual', async () => {
        const fetchRates = jest.fn();
        const { uc, tenantContext } = backupUseCase(fetchRates);
        const convert = tenantContext.run(TENANT, () =>
          uc.memoized({ manualBackup: true }),
        );
        await expect(
          tenantContext.run(TENANT, () =>
            convert.quote({ from: 'USD', to: 'COP', date: DAY }),
          ),
        ).resolves.toEqual({
          from: 'USD',
          to: 'COP',
          date: DAY,
          source: 'MANUAL',
          fromPerBase: 1,
          toPerBase: 4000,
          backup: { manualSince: SINCE },
        });
        expect(fetchRates).not.toHaveBeenCalled();
      });

      it('si la de respaldo no cubre las dos monedas, cotiza por el camino automático', async () => {
        const fetchRates = jest
          .fn()
          .mockResolvedValue({ base: 'USD', rates: { COP: 3900, EUR: 0.9 } });
        const { uc, tenantContext } = backupUseCase(fetchRates);
        const convert = tenantContext.run(TENANT, () =>
          uc.memoized({ manualBackup: true }),
        );
        await expect(
          tenantContext.run(TENANT, () =>
            convert.quote({ from: 'EUR', to: 'COP', date: DAY }),
          ),
        ).resolves.toEqual({
          from: 'EUR',
          to: 'COP',
          date: DAY,
          source: 'AUTOMATIC',
          fromPerBase: 0.9,
          toPerBase: 3900,
        });
        expect(fetchRates).toHaveBeenCalledWith(DAY);
      });

      it('sin la opción, el convertidor memoizado no usa la de respaldo', async () => {
        const fetchRates = jest
          .fn()
          .mockRejectedValue(new Error('proveedor caído'));
        const { uc, tenantContext } = backupUseCase(fetchRates);
        const convert = tenantContext.run(TENANT, () => uc.memoized());
        await expect(
          tenantContext.run(TENANT, () =>
            convert.quote({ from: 'USD', to: 'COP', date: DAY }),
          ),
        ).rejects.toThrow('proveedor caído');
      });
    });

    it('memoized().quote lee las tasas del día una sola vez', async () => {
      const findByDate = jest.fn(() =>
        Promise.resolve([
          {
            id: 'x',
            date: DATE,
            currency: 'COP',
            rate: 4000,
            fetchedAt: new Date(0),
          },
        ]),
      );
      const uc = new ConvertAmountUseCase(
        ratesUseCase(
          {
            findByDate,
            upsertMany: () => Promise.reject(new Error('no')),
          },
          { fetchRates: () => Promise.reject(new Error('no')) },
        ),
      );
      const convert = uc.memoized();
      await convert.quote({ from: 'COP', to: 'USD', date: DATE });
      await convert.execute({ amount: 5, from: 'COP', to: 'USD', date: DATE });
      expect(findByDate).toHaveBeenCalledTimes(1);
    });
  });

  // Revisión de DX-374: un convertidor memoizado por caso de uso (saldo,
  // totales) lee la caché una vez por día y da los mismos resultados.
  it('memoized() convierte igual y lee las tasas de cada día una sola vez', async () => {
    const findByDate = jest.fn((date: string) =>
      Promise.resolve(
        date === DATE
          ? [
              {
                id: 'x',
                date: DATE,
                currency: 'COP',
                rate: 4000,
                fetchedAt: new Date(0),
              },
            ]
          : [],
      ),
    );
    const repo: ExchangeRateRepository = {
      findByDate,
      upsertMany: () => Promise.reject(new Error('should not be called')),
    };
    const provider: ExchangeRateProvider = {
      fetchRates: () => Promise.reject(new Error('should not be called')),
    };
    const uc = new ConvertAmountUseCase(ratesUseCase(repo, provider));
    const convert = uc.memoized();
    const amounts = [1, 2, 5, 7, 100, 333];
    const memo = await Promise.all(
      amounts.map((amount) =>
        convert.execute({ amount, from: 'COP', to: 'USD', date: DATE }),
      ),
    );
    expect(findByDate).toHaveBeenCalledTimes(1);
    const fresh = await Promise.all(
      amounts.map((amount) =>
        uc.execute({ amount, from: 'COP', to: 'USD', date: DATE }),
      ),
    );
    expect(memo).toEqual(fresh);
  });
});
