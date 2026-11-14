import { computeBillablePlans } from './compute-billable-plans';
import { BillablePlanRow } from '../domain/entities/billable-plan.entity';

function row(overrides: Partial<BillablePlanRow> = {}): BillablePlanRow {
  return {
    id: 'tp-1',
    status: 'ACCEPTED',
    currency: 'VES',
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    billable: 1000,
    paidByCurrency: [],
    hasActivePaymentPlan: false,
    ...overrides,
  };
}

describe('computeBillablePlans', () => {
  it('total, abonado en la moneda del plan y saldo', () => {
    const [plan] = computeBillablePlans([
      row({ paidByCurrency: [{ currency: 'VES', amount: 300.1 }] }),
    ]);
    expect(plan).toEqual({
      id: 'tp-1',
      status: 'ACCEPTED',
      currency: 'VES',
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      total: 1000,
      paid: 300.1,
      paidOtherCurrencies: [],
      balance: 699.9,
      hasActivePaymentPlan: false,
      paymentsWithoutRate: [],
      rateProviderTimedOut: false,
    });
  });

  it('sin el saldo de `/balance`, un abono en otra moneda se informa aparte y no descuenta el saldo', () => {
    const [plan] = computeBillablePlans([
      row({
        paidByCurrency: [
          { currency: 'USD', amount: 10 },
          { currency: 'VES', amount: 100 },
          { currency: 'EUR', amount: 5 },
        ],
      }),
    ]);
    expect(plan.paid).toBe(100);
    expect(plan.balance).toBe(900);
    expect(plan.paidOtherCurrencies).toEqual([
      { currency: 'EUR', amount: 5 },
      { currency: 'USD', amount: 10 },
    ]);
  });

  it('suma en centavos: sin deriva de coma flotante', () => {
    const [plan] = computeBillablePlans([
      row({
        billable: 0.3,
        paidByCurrency: [{ currency: 'VES', amount: 0.1 }],
      }),
    ]);
    expect(plan.balance).toBe(0.2);
  });

  it('deja fuera los planes cancelados, los rechazados (DX-040) y los que no tienen nada facturable', () => {
    const plans = computeBillablePlans([
      row({ id: 'ok' }),
      row({ id: 'cancelled', status: 'CANCELLED' }),
      row({ id: 'rejected', status: 'REJECTED' }),
      row({ id: 'zero', billable: 0 }),
    ]);
    expect(plans.map((p) => p.id)).toEqual(['ok']);
  });

  it('conserva el orden y si ya hay un plan de cuotas activo', () => {
    const plans = computeBillablePlans([
      row({ id: 'a', hasActivePaymentPlan: true }),
      row({ id: 'b', status: 'COMPLETED' }),
      row({ id: 'c', status: 'DRAFT', billable: 50 }),
    ]);
    expect(plans.map((p) => [p.id, p.status, p.hasActivePaymentPlan])).toEqual([
      ['a', 'ACCEPTED', true],
      ['b', 'COMPLETED', false],
      ['c', 'DRAFT', false],
    ]);
  });

  it('saldo negativo cuando se abonó de más (a favor del paciente)', () => {
    const [plan] = computeBillablePlans([
      row({ paidByCurrency: [{ currency: 'VES', amount: 1500 }] }),
    ]);
    expect(plan.balance).toBe(-500);
  });

  it('con el saldo de `/balance` (DX-472-bis): lo de otra moneda cuenta convertido y los avisos pasan', () => {
    const withoutRate = {
      paymentId: 'pay-2',
      amount: 720,
      currency: 'VES',
      paidOn: '2026-03-06',
    };
    const [plan] = computeBillablePlans(
      [
        row({
          currency: 'USD',
          billable: 100,
          paidByCurrency: [{ currency: 'VES', amount: 4320 }],
        }),
      ],
      new Map([
        [
          'tp-1',
          {
            planCurrency: 'USD',
            billable: 100,
            paid: 100,
            creditMovements: 0,
            balance: 0,
            paymentsCount: 2,
            paymentsWithoutRate: [withoutRate],
            rateProviderTimedOut: true,
          },
        ],
      ]),
    );
    expect(plan).toMatchObject({
      total: 100,
      paid: 100,
      balance: 0,
      paidOtherCurrencies: [{ currency: 'VES', amount: 4320 }],
      paymentsWithoutRate: [withoutRate],
      rateProviderTimedOut: true,
    });
  });

  it('con el saldo de `/balance`, los asientos del saldo a favor suman a lo abonado', () => {
    const [plan] = computeBillablePlans(
      [row({ currency: 'USD', billable: 100 })],
      new Map([
        [
          'tp-1',
          {
            planCurrency: 'USD',
            billable: 100,
            paid: 30,
            creditMovements: 20,
            balance: 50,
            paymentsCount: 1,
            paymentsWithoutRate: [],
            rateProviderTimedOut: false,
          },
        ],
      ]),
    );
    expect(plan).toMatchObject({ paid: 50, balance: 50 });
  });
});
