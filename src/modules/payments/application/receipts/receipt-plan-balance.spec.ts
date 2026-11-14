import { ReceiptPlanBalanceCalculator } from './receipt-plan-balance';
import type { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';

function makeCalculator(
  before:
    | {
        planCurrency: string;
        billable: number;
        paid: number;
        rateProviderTimedOut?: boolean;
      }
    | Error = {
    planCurrency: 'USD',
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
        rateProviderTimedOut: before.rateProviderTimedOut ?? false,
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
      currency: 'USD',
      billable: 900000,
      paid: 500000,
      balance: 400000,
    });
    expect(balanceCalls).toEqual(['plan-1']);
  });

  it('un abono ya convertido a la moneda del plan suma tal cual', async () => {
    const { calculator } = makeCalculator({
      planCurrency: 'USD',
      billable: 900000,
      paid: 0,
    });
    await expect(calculator.afterPayment('plan-1', 200000)).resolves.toEqual({
      currency: 'USD',
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

  it('DX-054: con el proveedor de tasas fuera de plazo (saldo previo incompleto), null', async () => {
    const { calculator } = makeCalculator({
      planCurrency: 'USD',
      billable: 900000,
      paid: 0,
      rateProviderTimedOut: true,
    });
    await expect(calculator.afterPayment('plan-1', 10)).resolves.toBeNull();
  });

  it('si el saldo previo no se puede leer, null', async () => {
    const { calculator } = makeCalculator(new Error('caído'));
    await expect(calculator.afterPayment('plan-1', 10)).resolves.toBeNull();
  });

  describe('inTransaction (DX-182)', () => {
    const snapshot = {
      plan: { status: 'ACCEPTED', currency: 'USD' },
      items: [],
      payments: [],
      allocations: [],
      bases: [],
    } as unknown as Parameters<
      ReceiptPlanBalanceCalculator['inTransaction']
    >[0]['snapshot'];

    function withFromSnapshot(result: object | Error) {
      const calls: unknown[][] = [];
      const getPlanBalance = {
        fromSnapshot: (...args: unknown[]) => {
          calls.push(args);
          return result instanceof Error
            ? Promise.reject(result)
            : Promise.resolve(result);
        },
      } as unknown as GetPlanBalanceUseCase;
      return {
        calculator: new ReceiptPlanBalanceCalculator(getPlanBalance),
        calls,
      };
    }

    it('usa la cuenta del saldo del plan sobre la foto, sin red, y no suma nada a mano', async () => {
      const { calculator, calls } = withFromSnapshot({
        planCurrency: 'USD',
        billable: 1000,
        paid: 300,
        balance: 700,
        creditMovements: 0,
        paymentsWithoutRate: [],
        rateProviderTimedOut: false,
      });
      await expect(
        calculator.inTransaction({
          planId: 'plan-1',
          paymentIds: ['p-1'],
          snapshot,
          creditMovements: 0,
        }),
      ).resolves.toEqual({
        currency: 'USD',
        billable: 1000,
        paid: 300,
        balance: 700,
      });
      expect(calls).toEqual([['plan-1', snapshot, 0, { offline: true }]]);
    });

    it('un abono de este cobro sin tasa de su día no cuenta en el saldo: el recibo sale sin saldo', async () => {
      const { calculator } = withFromSnapshot({
        planCurrency: 'USD',
        billable: 1000,
        paid: 0,
        balance: 1000,
        creditMovements: 0,
        paymentsWithoutRate: [
          {
            paymentId: 'p-2',
            amount: 100,
            currency: 'VES',
            paidOn: '2026-10-16',
          },
        ],
        rateProviderTimedOut: false,
      });
      const data = { planId: 'plan-1', snapshot, creditMovements: 0 };
      // Un abono sin tasa AJENO al cobro no cambia nada...
      await expect(
        calculator.inTransaction({ ...data, paymentIds: ['p-1'] }),
      ).resolves.toMatchObject({ balance: 1000 });
      // ...el propio, sí: sin saldo.
      await expect(
        calculator.inTransaction({ ...data, paymentIds: ['p-1', 'p-2'] }),
      ).resolves.toBeNull();
    });

    it('con una tasa que no se pudo leer sin red, o un fallo, el recibo sale sin saldo', async () => {
      const timedOut = withFromSnapshot({
        planCurrency: 'USD',
        billable: 1000,
        paid: 0,
        balance: 1000,
        creditMovements: 0,
        rateProviderTimedOut: true,
      });
      await expect(
        timedOut.calculator.inTransaction({
          planId: 'plan-1',
          paymentIds: ['p-1'],
          snapshot,
          creditMovements: 0,
        }),
      ).resolves.toBeNull();
      const failed = withFromSnapshot(new Error('caído'));
      await expect(
        failed.calculator.inTransaction({
          planId: 'plan-1',
          paymentIds: ['p-1'],
          snapshot,
          creditMovements: 0,
        }),
      ).resolves.toBeNull();
    });
  });
});
