import { ReceiptPlanBalanceCalculator } from './receipt-plan-balance';
import type { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';

function makeCalculator(
  before: { planCurrency: string; billable: number; paid: number } | Error = {
    planCurrency: 'COP',
    billable: 900000,
    paid: 300000,
  },
) {
  const balanceCalls: string[] = [];
  const getPlanBalance = {
    execute: (planId: string) => {
      balanceCalls.push(planId);
      if (before instanceof Error) return Promise.reject(before);
      return Promise.resolve({
        ...before,
        balance: before.billable - before.paid,
        creditMovements: 0,
        paymentsCount: 1,
      });
    },
  } as unknown as GetPlanBalanceUseCase;
  return {
    calculator: new ReceiptPlanBalanceCalculator(getPlanBalance),
    balanceCalls,
  };
}

describe('ReceiptPlanBalanceCalculator (DX-136)', () => {
  it('saldo tras el abono: lo pagado antes más este abono, en la moneda del plan', async () => {
    const { calculator, balanceCalls } = makeCalculator();
    await expect(calculator.afterPayment('plan-1', 200000)).resolves.toEqual({
      currency: 'COP',
      billable: 900000,
      paid: 500000,
      balance: 400000,
    });
    expect(balanceCalls).toEqual(['plan-1']);
  });

  it('un abono ya convertido a la moneda del plan suma tal cual', async () => {
    const { calculator } = makeCalculator({
      planCurrency: 'COP',
      billable: 900000,
      paid: 0,
    });
    await expect(calculator.afterPayment('plan-1', 200000)).resolves.toEqual({
      currency: 'COP',
      billable: 900000,
      paid: 200000,
      balance: 700000,
    });
  });

  it('sin importe convertido (sin tasa) no inventa el saldo: null (el recibo se emite igual)', async () => {
    const { calculator, balanceCalls } = makeCalculator();
    await expect(calculator.afterPayment('plan-1', null)).resolves.toBeNull();
    expect(balanceCalls).toEqual([]);
  });

  it('si el saldo previo no se puede leer, null', async () => {
    const { calculator } = makeCalculator(new Error('caído'));
    await expect(calculator.afterPayment('plan-1', 10)).resolves.toBeNull();
  });
});
