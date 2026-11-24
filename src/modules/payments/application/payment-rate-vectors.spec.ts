import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import type {
  GetRatesForDateUseCase,
  RatesForDate,
} from '../../exchange/application/use-cases/get-rates-for-date.use-case';
import { freezePaymentRate, paymentAmountIn } from './payment-exchange-rate';
import { PlanBalanceCalculator } from './plan-balance-calculator';

// DX-398 (TST-050): los mismos vectores (copia byte a byte en la web,
// src/lib/payments/payment-rate-vectors.json, que comprueba
// scripts/check-api-reference-sync.mjs de la web) fijan la paridad API/web del
// abono en otra moneda: la tasa que se congela (8 decimales; la que redondea a
// 0 es «sin tasa»), el equivalente en la moneda del plan y lo pendiente tras
// el abono. Aquí corren por el código de producción: `ConvertAmountUseCase`
// (cotización), `freezePaymentRate`, `paymentAmountIn` y `PlanBalanceCalculator`.
// Solo se sustituye la lectura de las tasas del día (proveedor/caché).

interface Vector {
  name: string;
  amount: number;
  from: string;
  to: string;
  ratesPerUsd: Record<string, number>;
  pendingBefore: number;
  rate: { fromPerBase: number; toPerBase: number } | null;
  equivalent: number | null;
  pendingAfter: number | null;
}

interface Vectors {
  version: number;
  base: string;
  conversions: Vector[];
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, 'payment-rate-vectors.json'), 'utf8'),
) as Vectors;

const DAY = '2026-11-20';

/** El convertidor real sobre las tasas de un día (las del vector). */
function converterFor(rates: Record<string, number>): ConvertAmountUseCase {
  const read = (date: string): Promise<RatesForDate> =>
    Promise.resolve({
      base: 'USD',
      source: 'AUTOMATIC',
      rates,
      rateDate: date,
    });
  return new ConvertAmountUseCase({
    execute: read,
    memoized: () => read,
  } as unknown as GetRatesForDateUseCase);
}

describe('vectores del abono en otra moneda compartidos con la web (DX-398)', () => {
  it('versión y base de los vectores', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.base).toBe('USD');
  });

  it('cubren VES↔USD, EUR, una moneda sin decimales, tasas que redondean a 0 e importes grandes', () => {
    const pairs = new Set(vectors.conversions.map((v) => `${v.from}>${v.to}`));
    for (const pair of ['VES>USD', 'USD>VES', 'EUR>VES', 'VES>EUR']) {
      expect(pairs).toContain(pair);
    }
    expect(
      vectors.conversions.some((v) => v.from === 'JPY' || v.to === 'JPY'),
    ).toBe(true);
    expect(vectors.conversions.some((v) => v.rate === null)).toBe(true);
    expect(vectors.conversions.some((v) => v.equivalent === 0)).toBe(true);
    expect(vectors.conversions.some((v) => v.amount >= 1e11)).toBe(true);
    expect(vectors.conversions.some((v) => (v.pendingAfter ?? 0) < 0)).toBe(
      true,
    );
  });

  it.each(vectors.conversions)(
    '$name: $amount $from → $to',
    async ({
      amount,
      from,
      to,
      ratesPerUsd,
      pendingBefore,
      rate,
      equivalent,
      pendingAfter,
    }) => {
      const convert = converterFor(ratesPerUsd);
      const frozen = await freezePaymentRate(convert, {
        currency: from,
        targetCurrency: to,
        paidOn: DAY,
      });
      expect(
        frozen && {
          fromPerBase: frozen.fromPerBase,
          toPerBase: frozen.toPerBase,
        },
      ).toEqual(rate);

      const payment = {
        id: 'abono',
        amount,
        currency: from,
        paidOn: DAY,
        exchangeRateCurrency: to,
        frozenRate: frozen,
      };
      expect(await paymentAmountIn(convert, payment, to)).toBe(equivalent);

      const balances = await new PlanBalanceCalculator({
        memoized: () => convert,
      } as unknown as ConvertAmountUseCase).computeMany([
        {
          plan: {
            id: 'plan',
            status: TreatmentPlanStatus.ACCEPTED,
            currency: to,
          },
          items: [
            {
              status: TreatmentPlanItemStatus.ACCEPTED,
              price: pendingBefore,
              discount: 0,
            },
          ],
          payments: [payment],
          baseOf: new Map(),
          creditMovements: 0,
        },
      ]);
      const balance = balances.get('plan');
      // «Sin tasa»: el abono no cuenta y lo pendiente no cambia.
      expect(balance?.balance).toBe(pendingAfter ?? pendingBefore);
      expect(balance?.paymentsWithoutRate.length).toBe(rate === null ? 1 : 0);
    },
  );
});
