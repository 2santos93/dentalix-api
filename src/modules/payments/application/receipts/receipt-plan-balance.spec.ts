import { BadRequestException } from '@nestjs/common';
import { ReceiptPlanBalanceCalculator } from './receipt-plan-balance';
import type { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';
import type { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';

function makeCalculator(opts: {
  before?: { planCurrency: string; billable: number; paid: number } | Error;
  rate?: number | Error;
}) {
  const balanceCalls: string[] = [];
  const convertCalls: { from: string; to: string; date: string }[] = [];
  const getPlanBalance = {
    execute: (planId: string) => {
      balanceCalls.push(planId);
      const before = opts.before ?? {
        planCurrency: 'COP',
        billable: 900000,
        paid: 300000,
      };
      if (before instanceof Error) return Promise.reject(before);
      return Promise.resolve({
        ...before,
        balance: before.billable - before.paid,
        paymentsCount: 1,
      });
    },
  } as unknown as GetPlanBalanceUseCase;
  const convertAmount = {
    execute: (input: {
      amount: number;
      from: string;
      to: string;
      date: string;
    }) => {
      convertCalls.push({ from: input.from, to: input.to, date: input.date });
      const rate = opts.rate ?? 1;
      if (rate instanceof Error) return Promise.reject(rate);
      return Promise.resolve({
        ...input,
        result: Math.round(input.amount * rate * 100) / 100,
        rateUsed: rate,
      });
    },
  } as unknown as ConvertAmountUseCase;
  return {
    calculator: new ReceiptPlanBalanceCalculator(getPlanBalance, convertAmount),
    balanceCalls,
    convertCalls,
  };
}

describe('ReceiptPlanBalanceCalculator (DX-136)', () => {
  it('saldo tras el abono: lo pagado antes más este abono, en la moneda del plan', async () => {
    const { calculator, balanceCalls } = makeCalculator({});
    await expect(
      calculator.afterPayment({
        treatmentPlanId: 'plan-1',
        amount: 200000,
        currency: 'COP',
        paidOn: '2026-10-17',
      }),
    ).resolves.toEqual({
      currency: 'COP',
      billable: 900000,
      paid: 500000,
      balance: 400000,
    });
    expect(balanceCalls).toEqual(['plan-1']);
  });

  it('un abono en otra moneda se convierte con la tasa de SU día', async () => {
    const { calculator, convertCalls } = makeCalculator({
      before: { planCurrency: 'COP', billable: 900000, paid: 0 },
      rate: 4000,
    });
    await expect(
      calculator.afterPayment({
        treatmentPlanId: 'plan-1',
        amount: 50,
        currency: 'USD',
        paidOn: '2026-10-16',
      }),
    ).resolves.toEqual({
      currency: 'COP',
      billable: 900000,
      paid: 200000,
      balance: 700000,
    });
    expect(convertCalls).toEqual([
      { from: 'USD', to: 'COP', date: '2026-10-16' },
    ]);
  });

  it('sin tasa de cambio no inventa el saldo: null (el recibo se emite igual)', async () => {
    const { calculator } = makeCalculator({
      rate: new BadRequestException('unsupported currency: XYZ'),
    });
    await expect(
      calculator.afterPayment({
        treatmentPlanId: 'plan-1',
        amount: 10,
        currency: 'XYZ',
        paidOn: '2026-10-17',
      }),
    ).resolves.toBeNull();
  });

  it('si el saldo previo no se puede leer, null', async () => {
    const { calculator } = makeCalculator({ before: new Error('caído') });
    await expect(
      calculator.afterPayment({
        treatmentPlanId: 'plan-1',
        amount: 10,
        currency: 'COP',
        paidOn: '2026-10-17',
      }),
    ).resolves.toBeNull();
  });
});
