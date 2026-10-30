import { BadRequestException } from '@nestjs/common';
import type { AmountConverter } from '../../exchange/application/use-cases/convert-amount.use-case';
import { MissingExchangeRateError } from '../../exchange/domain/missing-exchange-rate.error';
import { ExchangeRateUnavailableError } from '../../exchange/domain/ports/exchange-rate-provider.port';
import {
  exchangeRateStatus,
  type FrozenExchangeRate,
} from '../domain/payment-exchange-rate';
import { freezePaymentRate, paymentAmountIn } from './payment-exchange-rate';
import { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { GetRatesForDateUseCase } from '../../exchange/application/use-cases/get-rates-for-date.use-case';
import {
  makeManualRates,
  makeSettings,
} from '../../exchange/application/__fixtures__/in-memory-exchange-settings';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

const DAY = '2026-10-30';
const FROZEN_AUTO: FrozenExchangeRate = {
  currency: 'USD',
  fromPerBase: 4000,
  toPerBase: 1,
  source: 'AUTOMATIC',
  date: DAY,
};

/** Un convertidor que falla si se le pide algo: la tasa congelada basta. */
function noLiveConverter(): AmountConverter {
  return {
    execute: () => Promise.reject(new Error('no debe convertir en vivo')),
    quote: () => Promise.reject(new Error('no debe cotizar')),
  };
}

function liveConverter(rateUsed: number): {
  convert: AmountConverter;
  execute: jest.Mock;
} {
  const execute = jest.fn().mockResolvedValue({ rateUsed });
  return {
    execute,
    convert: {
      execute,
      quote: () => Promise.reject(new Error('no debe cotizar')),
    },
  };
}

const cop = (over: Partial<Parameters<typeof paymentAmountIn>[1]> = {}) => ({
  amount: 200000,
  currency: 'COP',
  paidOn: DAY,
  exchangeRateCurrency: 'USD',
  frozenRate: FROZEN_AUTO,
  ...over,
});

describe('tasa congelada de un abono (DX-375)', () => {
  describe('exchangeRateStatus', () => {
    it('en la moneda de su destino no necesita tasa', () => {
      expect(
        exchangeRateStatus({
          currency: 'USD',
          exchangeRateCurrency: 'USD',
          frozenRate: null,
        }),
      ).toBe('NOT_NEEDED');
    });
    it('con tasa congelada', () => {
      expect(exchangeRateStatus(cop())).toBe('FROZEN');
    });
    it('nuevo sin tasa: «sin tasa»', () => {
      expect(exchangeRateStatus(cop({ frozenRate: null }))).toBe('MISSING');
    });
    it('anterior a DX-375 sin congelar: LEGACY', () => {
      expect(
        exchangeRateStatus(
          cop({ exchangeRateCurrency: null, frozenRate: null }),
        ),
      ).toBe('LEGACY');
    });
  });

  describe('paymentAmountIn', () => {
    it('usa la tasa congelada y nunca la del día', async () => {
      await expect(
        paymentAmountIn(noLiveConverter(), cop(), 'USD'),
      ).resolves.toBe(50);
    });

    it('cambiar la tasa después no altera el importe: manda la congelada', async () => {
      const { convert, execute } = liveConverter(1 / 5000);
      await expect(paymentAmountIn(convert, cop(), 'USD')).resolves.toBe(50);
      expect(execute).not.toHaveBeenCalled();
    });

    it('a la moneda base con la tasa de la moneda del abono', async () => {
      await expect(
        paymentAmountIn(
          noLiveConverter(),
          cop({
            exchangeRateCurrency: 'EUR',
            frozenRate: { ...FROZEN_AUTO, currency: 'EUR', toPerBase: 0.9 },
          }),
          'USD',
        ),
      ).resolves.toBe(50);
    });

    it('cruzada con las dos tasas congeladas, como la conversión en vivo', async () => {
      await expect(
        paymentAmountIn(
          noLiveConverter(),
          cop({
            exchangeRateCurrency: 'EUR',
            frozenRate: { ...FROZEN_AUTO, currency: 'EUR', toPerBase: 0.9 },
          }),
          'EUR',
        ),
      ).resolves.toBe(45);
    });

    it('en su propia moneda, el importe tal cual', async () => {
      await expect(
        paymentAmountIn(noLiveConverter(), cop(), 'COP'),
      ).resolves.toBe(200000);
    });

    it('sin tasa (nuevo) devuelve null y no convierte en vivo', async () => {
      const { convert, execute } = liveConverter(1 / 4000);
      await expect(
        paymentAmountIn(convert, cop({ frozenRate: null }), 'USD'),
      ).resolves.toBeNull();
      expect(execute).not.toHaveBeenCalled();
    });

    it('anterior a DX-375: con la tasa de su día, como antes (lectura compatible)', async () => {
      const { convert, execute } = liveConverter(1 / 4000);
      await expect(
        paymentAmountIn(
          convert,
          cop({ exchangeRateCurrency: null, frozenRate: null }),
          'USD',
        ),
      ).resolves.toBe(50);
      expect(execute).toHaveBeenCalledWith({
        amount: 200000,
        from: 'COP',
        to: 'USD',
        date: DAY,
      });
    });

    it('anterior sin tasa de su día: null', async () => {
      const convert: AmountConverter = {
        execute: () =>
          Promise.reject(new BadRequestException('unsupported currency: COP')),
        quote: () => Promise.reject(new Error('no')),
      };
      await expect(
        paymentAmountIn(
          convert,
          cop({ exchangeRateCurrency: null, frozenRate: null }),
          'USD',
        ),
      ).resolves.toBeNull();
    });
  });

  describe('freezePaymentRate', () => {
    it('congela las dos tasas por 1 USD, la fuente y el día', async () => {
      const quote = jest.fn().mockResolvedValue({
        from: 'VES',
        to: 'EUR',
        date: DAY,
        source: 'MANUAL',
        fromPerBase: 40.12345678,
        toPerBase: 0.9,
      });
      const convert: AmountConverter = {
        execute: () => Promise.reject(new Error('no')),
        quote,
      };
      await expect(
        freezePaymentRate(convert, {
          currency: 'VES',
          targetCurrency: 'EUR',
          paidOn: DAY,
        }),
      ).resolves.toEqual({
        currency: 'EUR',
        fromPerBase: 40.12345678,
        toPerBase: 0.9,
        source: 'MANUAL',
        date: DAY,
      });
      expect(quote).toHaveBeenCalledWith({
        from: 'VES',
        to: 'EUR',
        date: DAY,
      });
    });

    it.each([
      ['tasa manual sin registrar', new MissingExchangeRateError('VES', DAY)],
      [
        'moneda que el proveedor no trae',
        new BadRequestException('unsupported currency: VES'),
      ],
      ['proveedor caído', new ExchangeRateUnavailableError('caído')],
    ])('sin tasa (%s) devuelve null', async (_label, error) => {
      const convert: AmountConverter = {
        execute: () => Promise.reject(new Error('no')),
        quote: () => Promise.reject(error),
      };
      await expect(
        freezePaymentRate(convert, {
          currency: 'VES',
          targetCurrency: 'USD',
          paidOn: DAY,
        }),
      ).resolves.toBeNull();
    });

    it('otro fallo se propaga', async () => {
      const convert: AmountConverter = {
        execute: () => Promise.reject(new Error('no')),
        quote: () => Promise.reject(new Error('BD caída')),
      };
      await expect(
        freezePaymentRate(convert, {
          currency: 'VES',
          targetCurrency: 'USD',
          paidOn: DAY,
        }),
      ).rejects.toThrow('BD caída');
    });

    // Revisión DX-375: en un fallo de la caché el proveedor da la tasa con
    // más decimales de los que caben en Decimal(18,8). Lo congelado en memoria
    // (base, recibo) tiene que ser lo mismo que se guarda y se lee después.
    it('redondea las tasas a 8 decimales, lo que guarda la columna', async () => {
      const convert: AmountConverter = {
        execute: () => Promise.reject(new Error('no')),
        quote: () =>
          Promise.resolve({
            from: 'COP',
            to: 'USD',
            date: DAY,
            source: 'AUTOMATIC',
            fromPerBase: 3912.123456789,
            toPerBase: 1,
          }),
      };
      const frozen = await freezePaymentRate(convert, {
        currency: 'COP',
        targetCurrency: 'USD',
        paidOn: DAY,
      });
      expect(frozen).toMatchObject({
        fromPerBase: 3912.12345679,
        toPerBase: 1,
      });
    });

    it('una tasa que redondea a 0 con 8 decimales cuenta como «sin tasa»', async () => {
      const convert: AmountConverter = {
        execute: () => Promise.reject(new Error('no')),
        quote: () =>
          Promise.resolve({
            from: 'XAU',
            to: 'USD',
            date: DAY,
            source: 'AUTOMATIC',
            fromPerBase: 0.000000004,
            toPerBase: 1,
          }),
      };
      await expect(
        freezePaymentRate(convert, {
          currency: 'XAU',
          targetCurrency: 'USD',
          paidOn: DAY,
        }),
      ).resolves.toBeNull();
    });

    it('en la moneda del destino no hay nada que congelar', async () => {
      await expect(
        freezePaymentRate(noLiveConverter(), {
          currency: 'USD',
          targetCurrency: 'USD',
          paidOn: DAY,
        }),
      ).resolves.toBeNull();
    });
  });

  // Criterio DX-375: dos clínicas con fuentes distintas el MISMO día congelan
  // cada una la suya (A del proveedor, B la manual), sin mezclarse, y lo
  // congelado no se mueve cuando después cambian la tasa del proveedor, la
  // manual o la fuente.
  describe('dos clínicas con fuentes distintas el mismo día', () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';

    function clinics() {
      const tenantContext = new TenantContextService();
      const provider: Record<string, number> = { COP: 4000 };
      const settings = makeSettings({ [B]: 'MANUAL' }, tenantContext);
      const manual = makeManualRates(
        { [B]: { [DAY]: { COP: 4100 } } },
        tenantContext,
      );
      const convert = new ConvertAmountUseCase(
        new GetRatesForDateUseCase(
          {
            findByDate: (date) =>
              Promise.resolve(
                date === DAY
                  ? Object.entries(provider).map(([currency, rate]) => ({
                      id: `${date}:${currency}`,
                      date,
                      currency,
                      rate,
                      fetchedAt: new Date(0),
                    }))
                  : [],
              ),
            upsertMany: () => Promise.reject(new Error('no')),
          },
          { fetchRates: () => Promise.reject(new Error('no')) },
          settings,
          manual,
          tenantContext,
        ),
      );
      const freezeIn = (tenant: string) =>
        tenantContext.run(tenant, () =>
          freezePaymentRate(convert, {
            currency: 'COP',
            targetCurrency: 'USD',
            paidOn: DAY,
          }),
        );
      return { tenantContext, provider, settings, manual, convert, freezeIn };
    }

    it('cada una congela su tasa y su fuente, y el saldo no se mueve después', async () => {
      const c = clinics();
      const a = await c.freezeIn(A);
      const b = await c.freezeIn(B);
      expect(a).toEqual({
        currency: 'USD',
        fromPerBase: 4000,
        toPerBase: 1,
        source: 'AUTOMATIC',
        date: DAY,
      });
      expect(b).toEqual({
        currency: 'USD',
        fromPerBase: 4100,
        toPerBase: 1,
        source: 'MANUAL',
        date: DAY,
      });

      const amountWith = (tenant: string, frozenRate: FrozenExchangeRate) =>
        c.tenantContext.run(tenant, () =>
          paymentAmountIn(
            c.convert,
            {
              amount: 410000,
              currency: 'COP',
              paidOn: DAY,
              exchangeRateCurrency: 'USD',
              frozenRate,
            },
            'USD',
          ),
        );
      await expect(amountWith(A, a!)).resolves.toBe(102.5);
      await expect(amountWith(B, b!)).resolves.toBe(100);

      // Cambian el proveedor, la tasa manual de B y la fuente de A: nada se mueve.
      c.provider.COP = 5000;
      c.manual.rows(B)[0].rate = 5100;
      await c.tenantContext.run(A, () =>
        c.settings.set(() => ({ source: 'MANUAL', manualSince: DAY })),
      );
      await expect(amountWith(A, a!)).resolves.toBe(102.5);
      await expect(amountWith(B, b!)).resolves.toBe(100);
    });
  });
});
