import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { referenceCurrencyDigitsCatalog } from '../../../shared/money/__fixtures__/reference-currency-digits';
import { MissingExchangeRateError } from '../../exchange/domain/missing-exchange-rate.error';
import type { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import type { PaymentMethodRepository } from '../../payment-methods/domain/ports/payment-method-repository.port';
import type { ClinicPaymentMethodEntity } from '../../payment-methods/domain/payment-method.entity';
import type { CurrencyWhitelist } from '../../treatment-plans/domain/ports/currency-whitelist.port';
import { REFERENCE_REQUIRED_MESSAGE } from '../../payment-methods/domain/payment-method-rules';
import {
  CASH_CHANGE_REMAINDER,
  CHANGE_LINES_LIMIT_MESSAGE,
  CHANGE_NOT_CASH_MESSAGE,
  CHANGE_REMAINDER_WITH_ADJUSTMENTS_MESSAGE,
  CHANGE_WITHOUT_TENDERED_MESSAGE,
} from '../domain/cash-change';
import { CashChangePreparer, hasCashChange } from './cash-change-preparer';

/*
 * DX-570: preparar el vuelto (medio, referencia, decimales, tasa del día y
 * cuadre). Caso del ticket: cobro de 45 USD con un billete de 50 y vuelto de
 * 5 USD en bolívares por un medio que pide referencia.
 */

const medium = (
  over: Partial<ClinicPaymentMethodEntity>,
): ClinicPaymentMethodEntity => ({
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: 't-1',
  name: 'Efectivo',
  kind: 'CASH',
  active: true,
  requiresReference: false,
  proofPolicy: 'NONE',
  allowInPaymentLink: false,
  legacyMethod: 'CASH',
  adjustments: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const CASH = medium({});
const MOBILE = medium({
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Pago móvil',
  kind: 'DIGITAL',
  requiresReference: true,
  legacyMethod: null,
});
const INACTIVE = medium({
  id: '00000000-0000-4000-8000-000000000003',
  name: 'Transferencia antigua',
  kind: 'DIGITAL',
  active: false,
});

function build(perBase: Record<string, number> = { VES: 36.5 }) {
  const methods = {
    findById: (id: string) =>
      Promise.resolve(
        [CASH, MOBILE, INACTIVE].find((m) => m.id === id) ?? null,
      ),
  } as unknown as PaymentMethodRepository;
  const whitelist: CurrencyWhitelist = {
    has: (code: string) =>
      Promise.resolve(['USD', 'VES', 'JPY'].includes(code)),
  };
  const quotes: { from: string; to: string; date: string }[] = [];
  const convert = {
    quote: (input: { from: string; to: string; date: string }) => {
      quotes.push(input);
      const rate = (c: string) => (c === 'USD' ? 1 : perBase[c]);
      if (rate(input.from) === undefined || rate(input.to) === undefined) {
        return Promise.reject(
          new MissingExchangeRateError(input.from, input.date),
        );
      }
      return Promise.resolve({
        ...input,
        rateDate: input.date,
        source: 'MANUAL' as const,
        fromPerBase: rate(input.from),
        toPerBase: rate(input.to),
      });
    },
  } as unknown as ConvertAmountUseCase;
  const preparer = new CashChangePreparer(
    methods,
    whitelist,
    referenceCurrencyDigitsCatalog(),
    convert,
  );
  return { preparer, quotes };
}

const PAYMENT = {
  amount: 45,
  currency: 'USD',
  method: 'CASH' as const,
  collected: 45,
  hasAdjustments: false,
  paidOn: '2026-11-19',
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba un rechazo');
}

describe('CashChangePreparer (DX-570)', () => {
  it('sin nada del vuelto, la petición es la de hoy', () => {
    expect(hasCashChange({})).toBe(false);
    expect(hasCashChange({ change: [] })).toBe(false);
    expect(hasCashChange({ tendered: 50 })).toBe(true);
  });

  it('45 USD con 50 recibidos y 5 USD en VES por pago móvil: la tasa del día del abono congelada', async () => {
    const { preparer, quotes } = build();
    const { change, amount } = await preparer.prepare(
      {
        tendered: 50,
        change: [
          {
            paymentMethodId: MOBILE.id,
            currency: 'ves',
            amount: 182.5,
            reference: ' 0412-555 ',
          },
        ],
      },
      PAYMENT,
    );
    expect(amount).toBe(45);
    expect(change).toEqual({
      tendered: 50,
      remainderToCredit: 0,
      lines: [
        {
          line: 1,
          paymentMethodId: MOBILE.id,
          paymentMethodName: 'Pago móvil',
          method: 'TRANSFER',
          currency: 'VES',
          amount: 182.5,
          reference: '0412-555',
          referenceNormalized: '0412555',
          equivalentAmount: 5,
          rate: {
            fromPerBase: 36.5,
            toPerBase: 1,
            source: 'MANUAL',
            date: '2026-11-19',
          },
        },
      ],
    });
    expect(quotes).toEqual([{ from: 'VES', to: 'USD', date: '2026-11-19' }]);
  });

  it('vuelto en la misma moneda y medio: sin tasa', async () => {
    const { preparer, quotes } = build();
    const { change } = await preparer.prepare(
      {
        tendered: 50,
        change: [{ paymentMethodId: CASH.id, currency: 'USD', amount: 5 }],
      },
      PAYMENT,
    );
    expect(change.lines[0]).toMatchObject({
      method: 'CASH',
      equivalentAmount: 5,
      rate: null,
    });
    expect(quotes).toEqual([]);
  });

  it('vuelto mayor que lo recibido menos lo cobrado: 422', async () => {
    const { preparer } = build();
    const error = await rejection(
      preparer.prepare(
        {
          tendered: 50,
          change: [{ paymentMethodId: CASH.id, currency: 'USD', amount: 5.01 }],
        },
        PAYMENT,
      ),
    );
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as Error).message).toBe(
      'El vuelto (5.01 USD) supera lo recibido menos lo cobrado (5.00 USD).',
    );
  });

  it('diferencia sin devolver y sin confirmar: 422 con código, resto y moneda', async () => {
    const { preparer } = build();
    const error = (await rejection(
      preparer.prepare(
        {
          tendered: 50,
          change: [{ paymentMethodId: CASH.id, currency: 'USD', amount: 3 }],
        },
        PAYMENT,
      ),
    )) as UnprocessableEntityException;
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse()).toMatchObject({
      code: CASH_CHANGE_REMAINDER,
      remainder: 2,
      currency: 'USD',
    });
  });

  it('diferencia confirmada: se suma al importe (saldo a favor)', async () => {
    const { preparer } = build();
    const { change, amount } = await preparer.prepare(
      {
        tendered: 50,
        change: [{ paymentMethodId: CASH.id, currency: 'USD', amount: 3 }],
        changeRemainderToCredit: true,
      },
      PAYMENT,
    );
    expect(amount).toBe(47);
    expect(change.remainderToCredit).toBe(2);
  });

  it('recibido sin vuelto y confirmado: todo lo de más va al abono', async () => {
    const { preparer } = build();
    const { amount, change } = await preparer.prepare(
      { tendered: 50, changeRemainderToCredit: true },
      PAYMENT,
    );
    expect(amount).toBe(50);
    expect(change).toEqual({ tendered: 50, remainderToCredit: 5, lines: [] });
  });

  it('con ajustes por medio de pago, un resto es 422 aunque se confirme', async () => {
    const { preparer } = build();
    await expect(
      preparer.prepare(
        { tendered: 50, changeRemainderToCredit: true },
        { ...PAYMENT, collected: 46.35, hasAdjustments: true },
      ),
    ).rejects.toThrow(CHANGE_REMAINDER_WITH_ADJUSTMENTS_MESSAGE);
  });

  it('con ajustes, el vuelto sobre lo cobrado (no sobre el importe)', async () => {
    const { preparer } = build();
    const { amount } = await preparer.prepare(
      {
        tendered: 50,
        change: [{ paymentMethodId: CASH.id, currency: 'USD', amount: 3.65 }],
      },
      { ...PAYMENT, collected: 46.35, hasAdjustments: true },
    );
    expect(amount).toBe(45);
  });

  it('recibido menor que lo cobrado: 400', async () => {
    const { preparer } = build();
    await expect(preparer.prepare({ tendered: 40 }, PAYMENT)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('sin tasa del día para la moneda del vuelto: 422 en español', async () => {
    const { preparer } = build({});
    await expect(
      preparer.prepare(
        {
          tendered: 50,
          change: [
            {
              paymentMethodId: MOBILE.id,
              currency: 'VES',
              amount: 182.5,
              reference: '123',
            },
          ],
        },
        PAYMENT,
      ),
    ).rejects.toThrow('No hay tasa del día entre VES y USD');
  });

  it('el medio que pide referencia la exige también en el vuelto', async () => {
    const { preparer } = build();
    await expect(
      preparer.prepare(
        {
          tendered: 50,
          change: [
            { paymentMethodId: MOBILE.id, currency: 'VES', amount: 182.5 },
          ],
        },
        PAYMENT,
      ),
    ).rejects.toThrow(REFERENCE_REQUIRED_MESSAGE);
  });

  it('un medio desactivado o de otra clínica: 400', async () => {
    const { preparer } = build();
    for (const paymentMethodId of [
      INACTIVE.id,
      '00000000-0000-4000-8000-0000000000ff',
    ]) {
      await expect(
        preparer.prepare(
          {
            tendered: 50,
            change: [{ paymentMethodId, currency: 'USD', amount: 5 }],
          },
          PAYMENT,
        ),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('solo en un abono en efectivo', async () => {
    const { preparer } = build();
    await expect(
      preparer.prepare({ tendered: 50 }, { ...PAYMENT, method: 'TRANSFER' }),
    ).rejects.toThrow(CHANGE_NOT_CASH_MESSAGE);
  });

  it('vuelto sin recibido, o más de 3 líneas: 400 antes de tocar nada', () => {
    const { preparer } = build();
    expect(() =>
      preparer.assertShape({
        change: [{ paymentMethodId: CASH.id, currency: 'USD', amount: 1 }],
      }),
    ).toThrow(CHANGE_WITHOUT_TENDERED_MESSAGE);
    const line = { paymentMethodId: CASH.id, currency: 'USD', amount: 1 };
    expect(() =>
      preparer.assertShape({ tendered: 50, change: [line, line, line, line] }),
    ).toThrow(CHANGE_LINES_LIMIT_MESSAGE);
  });

  it('decimales de redondeo de cada moneda (DX-340): JPY sin decimales', async () => {
    const { preparer } = build({ JPY: 150 });
    await expect(
      preparer.prepare(
        {
          tendered: 50,
          change: [
            { paymentMethodId: CASH.id, currency: 'JPY', amount: 750.5 },
          ],
        },
        PAYMENT,
      ),
    ).rejects.toThrow('El vuelto en JPY va sin decimales.');
    const { change } = await preparer.prepare(
      {
        tendered: 50,
        change: [{ paymentMethodId: CASH.id, currency: 'JPY', amount: 750 }],
      },
      PAYMENT,
    );
    expect(change.lines[0].equivalentAmount).toBe(5);
  });

  it('vuelto en dos monedas: USD en billetes y el resto en VES', async () => {
    const { preparer } = build();
    const { change } = await preparer.prepare(
      {
        tendered: 50,
        change: [
          { paymentMethodId: CASH.id, currency: 'USD', amount: 2 },
          { paymentMethodId: CASH.id, currency: 'VES', amount: 109.5 },
        ],
      },
      PAYMENT,
    );
    expect(change.lines.map((l) => l.equivalentAmount)).toEqual([2, 3]);
  });
});
