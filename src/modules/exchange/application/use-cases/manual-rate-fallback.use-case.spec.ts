import { GetRatesForDateUseCase } from './get-rates-for-date.use-case';
import { ConvertAmountUseCase } from './convert-amount.use-case';
import { MissingExchangeRateError } from '../../domain/missing-exchange-rate.error';
import type { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  makeManualRates,
  makeSettings,
} from '../__fixtures__/in-memory-exchange-settings';

// DX-384: la última tasa manual registrada, hasta N días, sustituye a la del
// día del abono. Dos clínicas con la misma tasa del viernes 30/10/2026 y
// distinto plazo (3 y 0) dan resultados distintos el sábado.
const FRI = '2026-10-30';
const SAT = '2026-10-31';
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WITH_3 = '33333333-3333-4333-8333-333333333333';
const WITH_0 = '00000000-0000-4000-8000-000000000000';

const noProviderRepo: ExchangeRateRepository = {
  findByDate: () => Promise.reject(new Error('el proveedor no se toca')),
  upsertMany: () => Promise.reject(new Error('el proveedor no se toca')),
};

function setup(
  rows: Record<string, Record<string, Record<string, number>>> = {
    [WITH_3]: { [FRI]: { VES: 36.5 } },
    [WITH_0]: { [FRI]: { VES: 36.5 } },
  },
) {
  const tenantContext = new TenantContextService();
  const settings = makeSettings(
    {
      [WITH_3]: {
        source: 'MANUAL',
        manualSince: '2026-10-01',
        manualRateMaxAgeDays: 3,
      },
      [WITH_0]: {
        source: 'MANUAL',
        manualSince: '2026-10-01',
        manualRateMaxAgeDays: 0,
      },
    },
    tenantContext,
  );
  const fetchRates = jest.fn();
  const rates = new GetRatesForDateUseCase(
    noProviderRepo,
    { fetchRates },
    settings,
    makeManualRates(rows, tenantContext),
    tenantContext,
  );
  const convert = new ConvertAmountUseCase(rates);
  const as = <T>(tenant: string, fn: () => Promise<T>) =>
    tenantContext.run(tenant, fn);
  return { rates, convert, as, fetchRates };
}

describe('tasa manual de respaldo hasta N días (DX-384)', () => {
  describe('cotización', () => {
    it('el sábado y el lunes usan la tasa del viernes con N=3 y dicen su fecha', async () => {
      const { convert, as } = setup();
      for (const day of [SAT, MON]) {
        await expect(
          as(WITH_3, () =>
            convert.quote({ from: 'VES', to: 'USD', date: day }),
          ),
        ).resolves.toMatchObject({
          date: day,
          rateDate: FRI,
          source: 'MANUAL',
          fromPerBase: 36.5,
          toPerBase: 1,
        });
      }
    });

    it('pasado el plazo (4 días) es «sin tasa», nunca 1:1', async () => {
      const { convert, as } = setup();
      await expect(
        as(WITH_3, () => convert.quote({ from: 'VES', to: 'USD', date: TUE })),
      ).rejects.toBeInstanceOf(MissingExchangeRateError);
      await expect(
        as(WITH_3, () =>
          convert.execute({ amount: 100, from: 'VES', to: 'USD', date: TUE }),
        ),
      ).rejects.toBeInstanceOf(MissingExchangeRateError);
    });

    it('con N=0 solo vale el día exacto: la misma tasa del viernes deja el sábado sin tasa', async () => {
      const { convert, as } = setup();
      await expect(
        as(WITH_0, () => convert.quote({ from: 'VES', to: 'USD', date: FRI })),
      ).resolves.toMatchObject({ rateDate: FRI });
      await expect(
        as(WITH_0, () => convert.quote({ from: 'VES', to: 'USD', date: SAT })),
      ).rejects.toBeInstanceOf(MissingExchangeRateError);
      // Y la clínica con N=3 sí la usa el mismo sábado.
      await expect(
        as(WITH_3, () => convert.quote({ from: 'VES', to: 'USD', date: SAT })),
      ).resolves.toMatchObject({ rateDate: FRI });
    });

    it('si hay tasa del propio día manda sobre la anterior', async () => {
      const { convert, as } = setup({
        [WITH_3]: { [FRI]: { VES: 36.5 }, [SAT]: { VES: 37 } },
        [WITH_0]: {},
      });
      await expect(
        as(WITH_3, () => convert.quote({ from: 'VES', to: 'USD', date: SAT })),
      ).resolves.toMatchObject({ rateDate: SAT, fromPerBase: 37 });
    });

    it('una tasa posterior al día nunca se usa', async () => {
      const { convert, as } = setup({
        [WITH_3]: { [SAT]: { VES: 37 } },
        [WITH_0]: {},
      });
      await expect(
        as(WITH_3, () => convert.quote({ from: 'VES', to: 'USD', date: FRI })),
      ).rejects.toBeInstanceOf(MissingExchangeRateError);
    });

    it('con dos monedas distintas de USD usa UNA fecha común, la mayor dentro del plazo con las dos', async () => {
      const { convert, as } = setup({
        [WITH_3]: {
          '2026-10-29': { VES: 36, EUR: 0.9 },
          [FRI]: { VES: 36.5 },
        },
        [WITH_0]: {},
      });
      await expect(
        as(WITH_3, () => convert.quote({ from: 'EUR', to: 'VES', date: SAT })),
      ).resolves.toMatchObject({
        rateDate: '2026-10-29',
        fromPerBase: 0.9,
        toPerBase: 36,
      });
      // Sin EUR registrado en ningún día del plazo: «sin tasa».
      const other = setup();
      await expect(
        other.as(WITH_3, () =>
          other.convert.quote({ from: 'EUR', to: 'VES', date: SAT }),
        ),
      ).rejects.toBeInstanceOf(MissingExchangeRateError);
    });

    it('nunca llama al proveedor', async () => {
      const { convert, as, fetchRates } = setup();
      await as(WITH_3, () =>
        convert.quote({ from: 'VES', to: 'USD', date: SAT }),
      );
      await as(WITH_3, () =>
        convert.quote({ from: 'VES', to: 'USD', date: TUE }),
      ).catch(() => undefined);
      expect(fetchRates).not.toHaveBeenCalled();
    });

    it('la lectura memoizada distingue las monedas pedidas', async () => {
      const { convert, as } = setup({
        [WITH_3]: { [FRI]: { VES: 36.5, EUR: 0.9 } },
        [WITH_0]: {},
      });
      const memo = as(WITH_3, () => Promise.resolve(convert.memoized()));
      const m = await memo;
      await expect(
        as(WITH_3, () => m.quote({ from: 'VES', to: 'USD', date: SAT })),
      ).resolves.toMatchObject({ rateDate: FRI, toPerBase: 1 });
      await expect(
        as(WITH_3, () => m.quote({ from: 'EUR', to: 'USD', date: SAT })),
      ).resolves.toMatchObject({ rateDate: FRI, fromPerBase: 0.9 });
    });
  });

  describe('lectura de tasas del día (GET /exchange/rates)', () => {
    it('sin monedas pedidas, solo el día exacto (como siempre)', async () => {
      const { rates, as } = setup();
      await expect(as(WITH_3, () => rates.forRequest(SAT))).resolves.toEqual({
        base: 'USD',
        source: 'MANUAL',
        rates: {},
        rateDate: SAT,
      });
    });

    it('con monedas pedidas devuelve la fecha de la tasa usada', async () => {
      const { rates, as } = setup();
      await expect(
        as(WITH_3, () => rates.forRequest(SAT, { currencies: ['VES', 'USD'] })),
      ).resolves.toEqual({
        base: 'USD',
        source: 'MANUAL',
        rates: { VES: 36.5 },
        rateDate: FRI,
      });
      await expect(
        as(WITH_0, () => rates.forRequest(SAT, { currencies: ['VES'] })),
      ).resolves.toEqual({
        base: 'USD',
        source: 'MANUAL',
        rates: {},
        rateDate: SAT,
      });
    });
  });
});
