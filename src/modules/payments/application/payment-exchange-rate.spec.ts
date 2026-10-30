import { BadRequestException } from '@nestjs/common';
import type { AmountConverter } from '../../exchange/application/use-cases/convert-amount.use-case';
import { MissingExchangeRateError } from '../../exchange/domain/missing-exchange-rate.error';
import { ExchangeRateUnavailableError } from '../../exchange/domain/ports/exchange-rate-provider.port';
import {
  exchangeRateStatus,
  type FrozenExchangeRate,
} from '../domain/payment-exchange-rate';
import { freezePaymentRate, paymentAmountIn } from './payment-exchange-rate';

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
});
