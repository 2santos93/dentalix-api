import {
  StatementOpeningBalanceRow,
  StatementPaymentPlanRow,
  StatementPaymentRow,
  StatementPlanRow,
  StatementSnapshot,
} from '../domain/entities/account-statement.entity';
import { computeAccountStatement } from './compute-account-statement';

const TODAY = new Date('2026-03-01T15:00:00.000Z');
const SEDE = { id: 'loc-1', name: 'Sede Principal' };

function plan(
  id: string,
  overrides: Partial<StatementPlanRow> = {},
): StatementPlanRow {
  return {
    id,
    status: 'ACCEPTED',
    currency: 'COP',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    billable: 0,
    ...overrides,
  };
}

let paymentSeq = 0;
function payment(
  treatmentPlanId: string,
  amount: number,
  overrides: Partial<StatementPaymentRow> = {},
): StatementPaymentRow {
  paymentSeq += 1;
  return {
    id: `pay-${paymentSeq}`,
    treatmentPlanId,
    amount,
    currency: 'COP',
    paidAt: new Date('2026-02-01T00:00:00.000Z'),
    method: 'CASH',
    paymentMethod: null,
    reference: null,
    location: SEDE,
    createdById: 'u-recep',
    createdAt: new Date('2026-02-01T14:00:00.000Z'),
    timeZone: 'America/Bogota',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...overrides,
  };
}

function paymentPlan(
  treatmentPlanId: string,
  overrides: Partial<StatementPaymentPlanRow> = {},
): StatementPaymentPlanRow {
  return {
    id: `pp-${treatmentPlanId}`,
    treatmentPlanId,
    currency: 'COP',
    status: 'ACTIVE',
    downPayment: 0,
    startDate: new Date('2026-01-15T00:00:00.000Z'),
    installments: [
      {
        sequence: 1,
        dueDate: new Date('2026-01-15T00:00:00.000Z'),
        amount: 100,
      },
      {
        sequence: 2,
        dueDate: new Date('2026-02-15T00:00:00.000Z'),
        amount: 100,
      },
      {
        sequence: 3,
        dueDate: new Date('2026-04-15T00:00:00.000Z'),
        amount: 100,
      },
    ],
    ...overrides,
  };
}

function snapshot(partial: Partial<StatementSnapshot>): StatementSnapshot {
  return { plans: [], payments: [], paymentPlans: [], ...partial };
}

describe('computeAccountStatement', () => {
  it('returns an empty statement for a patient with no plans or payments', () => {
    const out = computeAccountStatement(snapshot({}), { today: TODAY });
    expect(out).toEqual({
      summary: [],
      plans: [],
      movements: [],
      installments: [],
      openingBalances: [],
    });
  });

  it('adds budgeted and paid per plan and per currency', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [
          plan('tp-1', { billable: 1000 }),
          plan('tp-2', { billable: 500.5 }),
        ],
        payments: [
          payment('tp-1', 300),
          payment('tp-2', 0.1),
          payment('tp-2', 0.2),
        ],
      }),
      { today: TODAY },
    );

    expect(out.summary).toEqual([
      {
        currency: 'COP',
        budgeted: 1500.5,
        openingBalance: 0,
        openingPending: 0,
        paid: 300.3,
        creditMovements: 0,
        balance: 1200.2,
        overdueCount: 0,
        overdueAmount: 0,
        nextInstallment: null,
      },
    ]);
    expect(out.plans.map((p) => [p.id, p.budgeted, p.paid, p.balance])).toEqual(
      [
        ['tp-1', 1000, 300, 700],
        ['tp-2', 500.5, 0.3, 500.2],
      ],
    );
  });

  it('keeps every currency separate, without converting', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [
          plan('tp-cop', { billable: 1000 }),
          plan('tp-usd', { currency: 'USD', billable: 200 }),
        ],
        payments: [
          payment('tp-cop', 400),
          payment('tp-usd', 50, { currency: 'USD' }),
          // Abono en USD contra un plan en COP: suma a USD, no al plan COP.
          payment('tp-cop', 10, { currency: 'USD' }),
        ],
      }),
      { today: TODAY },
    );

    expect(
      out.summary.map((s) => [s.currency, s.budgeted, s.paid, s.balance]),
    ).toEqual([
      ['COP', 1000, 400, 600],
      ['USD', 200, 60, 140],
    ]);
    const cop = out.plans.find((p) => p.id === 'tp-cop');
    expect(cop).toMatchObject({
      paid: 400,
      balance: 600,
      paidOtherCurrencies: [{ currency: 'USD', amount: 10 }],
    });
  });

  it('lists voided payments as movements but never adds them up', () => {
    const voidedAt = new Date('2026-02-03T10:00:00.000Z');
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 1000 })],
        payments: [payment('tp-1', 300), payment('tp-1', 999, { voidedAt })],
      }),
      { today: TODAY },
    );

    expect(out.summary[0]).toMatchObject({ paid: 300, balance: 700 });
    expect(out.plans[0]).toMatchObject({ paid: 300, balance: 700 });
    expect(out.movements).toHaveLength(2);
    expect(out.movements.find((m) => m.amount === 999)).toMatchObject({
      voided: true,
      voidedAt,
    });
    expect(out.movements.find((m) => m.amount === 300)).toMatchObject({
      voided: false,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    });
  });

  it('DX-395: cada movimiento lleva el medio de la clínica y la referencia del abono', () => {
    const mobile = { id: 'pm-mobile', name: 'Pago móvil' };
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 1000 })],
        payments: [
          payment('tp-1', 300, {
            method: 'TRANSFER',
            paymentMethod: mobile,
            reference: 'ABC 123',
          }),
          payment('tp-1', 200, { method: null }),
        ],
      }),
      { today: TODAY },
    );

    expect(out.movements.find((m) => m.amount === 300)).toMatchObject({
      method: 'TRANSFER',
      paymentMethod: mobile,
      reference: 'ABC 123',
    });
    expect(out.movements.find((m) => m.amount === 200)).toMatchObject({
      method: null,
      paymentMethod: null,
      reference: null,
    });
  });

  it('carries who voided a payment and why (SEC-013)', () => {
    const voidedAt = new Date('2026-02-03T10:00:00.000Z');
    const voidedBy = { id: 'u-recep', fullName: 'Rita Recepción' };
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 1000 })],
        payments: [
          payment('tp-1', 999, {
            voidedAt,
            voidedBy,
            voidReason: 'Cobro duplicado',
          }),
        ],
      }),
      { today: TODAY },
    );

    expect(out.movements[0]).toMatchObject({
      voided: true,
      voidedBy,
      voidReason: 'Cobro duplicado',
    });
  });

  it('excludes a CANCELLED plan from budgeted but keeps its payments as paid', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [
          plan('tp-ok', { billable: 1000 }),
          plan('tp-cancelled', { status: 'CANCELLED', billable: 800 }),
        ],
        payments: [payment('tp-cancelled', 200)],
      }),
      { today: TODAY },
    );

    expect(out.summary[0]).toMatchObject({
      budgeted: 1000,
      paid: 200,
      balance: 800,
    });
    expect(out.plans.find((p) => p.id === 'tp-cancelled')).toMatchObject({
      budgeted: 800,
      countsTowardsBalance: false,
      paid: 200,
      // Nada que cobrar; lo abonado queda a favor del paciente.
      balance: -200,
    });
  });

  it('un plan REJECTED (DX-040) no suma al saldo, igual que uno cancelado', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [
          plan('tp-ok', { billable: 1000 }),
          plan('tp-rejected', { status: 'REJECTED', billable: 800 }),
        ],
      }),
      { today: TODAY },
    );
    expect(out.summary[0]).toMatchObject({ budgeted: 1000, balance: 1000 });
    expect(out.plans.find((p) => p.id === 'tp-rejected')).toMatchObject({
      countsTowardsBalance: false,
      balance: 0,
    });
  });

  it('counts DRAFT and COMPLETED plans by their billable items', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [
          plan('tp-draft', { status: 'DRAFT', billable: 0 }),
          plan('tp-done', { status: 'COMPLETED', billable: 400 }),
        ],
      }),
      { today: TODAY },
    );
    expect(out.summary[0]).toMatchObject({ budgeted: 400, balance: 400 });
    expect(out.plans.map((p) => p.countsTowardsBalance)).toEqual([true, true]);
  });

  it('omits a currency whose every figure is zero', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-draft', { status: 'DRAFT', currency: 'USD' })],
      }),
      { today: TODAY },
    );
    expect(out.summary).toEqual([]);
    // El plan sí aparece en el detalle.
    expect(out.plans).toHaveLength(1);
  });

  it('derives installment statuses greedily from the plan payments', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 300 })],
        payments: [payment('tp-1', 140)],
        paymentPlans: [paymentPlan('tp-1')],
      }),
      { today: TODAY },
    );

    expect(
      out.installments.map((i) => [
        i.sequence,
        i.status,
        i.covered,
        i.outstanding,
      ]),
    ).toEqual([
      [1, 'PAID', 100, 0],
      [2, 'OVERDUE', 40, 60],
      [3, 'PENDING', 0, 100],
    ]);
    expect(out.summary[0]).toMatchObject({
      overdueCount: 1,
      overdueAmount: 60,
      nextInstallment: {
        treatmentPlanId: 'tp-1',
        sequence: 3,
        dueDate: new Date('2026-04-15T00:00:00.000Z'),
        amount: 100,
      },
    });
  });

  it('puts the down payment first and covers it before the installments', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 350 })],
        payments: [payment('tp-1', 50)],
        paymentPlans: [paymentPlan('tp-1', { downPayment: 50 })],
      }),
      { today: TODAY },
    );
    expect(out.installments[0]).toMatchObject({
      kind: 'DOWN_PAYMENT',
      sequence: null,
      status: 'PAID',
      amount: 50,
    });
    expect(out.installments[1]).toMatchObject({
      kind: 'INSTALLMENT',
      sequence: 1,
      status: 'OVERDUE',
    });
    expect(out.summary[0]).toMatchObject({
      overdueCount: 2,
      overdueAmount: 200,
    });
  });

  it('ignores voided and other-currency payments when covering installments', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 300 })],
        payments: [
          payment('tp-1', 100, { voidedAt: new Date('2026-02-02') }),
          payment('tp-1', 100, { currency: 'USD' }),
        ],
        paymentPlans: [paymentPlan('tp-1')],
      }),
      { today: TODAY },
    );
    expect(out.installments.map((i) => i.status)).toEqual([
      'OVERDUE',
      'OVERDUE',
      'PENDING',
    ]);
  });

  it('drops the installments of a cancelled treatment plan', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { status: 'CANCELLED', billable: 300 })],
        paymentPlans: [paymentPlan('tp-1')],
      }),
      { today: TODAY },
    );
    expect(out.installments).toEqual([]);
    expect(out.summary).toEqual([]);
  });

  it('picks the earliest not-yet-due installment across plans as the next one', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [
          plan('tp-a', { billable: 300 }),
          plan('tp-b', { billable: 300 }),
        ],
        paymentPlans: [
          paymentPlan('tp-a'),
          paymentPlan('tp-b', {
            installments: [
              {
                sequence: 1,
                dueDate: new Date('2026-03-10T00:00:00.000Z'),
                amount: 300,
              },
            ],
          }),
        ],
      }),
      { today: TODAY },
    );
    expect(out.summary[0].nextInstallment).toMatchObject({
      treatmentPlanId: 'tp-b',
      sequence: 1,
      amount: 300,
    });
    // Ordenadas por vencimiento.
    expect(
      out.installments.map((i) => i.dueDate.toISOString().slice(0, 10)),
    ).toEqual(['2026-01-15', '2026-02-15', '2026-03-10', '2026-04-15']);
  });

  it('treats an installment due today as pending, not overdue', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 100 })],
        paymentPlans: [
          paymentPlan('tp-1', {
            installments: [
              {
                sequence: 1,
                dueDate: new Date('2026-03-01T00:00:00.000Z'),
                amount: 100,
              },
            ],
          }),
        ],
      }),
      { today: TODAY },
    );
    expect(out.installments[0].status).toBe('PENDING');
    expect(out.summary[0].overdueCount).toBe(0);
  });

  it('filters movements by the civil-date range IN THE SEDE ZONE without touching the totals (DX-097)', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 1000 })],
        payments: [
          // 31/01 23:00 en la zona de la sede (01/02 04:00 UTC): fuera.
          payment('tp-1', 100, {
            paidAt: new Date('2026-02-01T04:00:00.000Z'),
          }),
          // 01/02 00:30 en la zona de la sede: dentro.
          payment('tp-1', 200, {
            paidAt: new Date('2026-02-01T05:30:00.000Z'),
          }),
          // 28/02 22:00 en la zona de la sede (01/03 03:00 UTC): dentro.
          payment('tp-1', 300, {
            paidAt: new Date('2026-03-01T03:00:00.000Z'),
          }),
          // 01/03 00:30 en la zona de la sede: fuera.
          payment('tp-1', 400, {
            paidAt: new Date('2026-03-01T05:30:00.000Z'),
          }),
        ],
      }),
      {
        today: TODAY,
        movementsFrom: '2026-02-01',
        movementsTo: '2026-02-28',
      },
    );
    expect(out.movements.map((m) => m.amount)).toEqual([300, 200]);
    expect(out.movements.map((m) => m.paidOn)).toEqual([
      '2026-02-28',
      '2026-02-01',
    ]);
    expect(out.summary[0]).toMatchObject({ paid: 1000, balance: 0 });
  });

  it('orders movements newest first with a stable tie-break', () => {
    const day = new Date('2026-02-01T00:00:00.000Z');
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('tp-1', { billable: 10 })],
        payments: [
          payment('tp-1', 1, { id: 'a', paidAt: day }),
          payment('tp-1', 2, { id: 'b', paidAt: day }),
          payment('tp-1', 3, { id: 'c', paidAt: new Date('2026-02-02') }),
        ],
      }),
      { today: TODAY },
    );
    expect(out.movements.map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });

  describe('saldo migrado (DX-262)', () => {
    function opening(
      id: string,
      amount: number,
      overrides: Partial<StatementOpeningBalanceRow> = {},
    ): StatementOpeningBalanceRow {
      return {
        id,
        currency: 'COP',
        amount,
        asOfDate: '2025-12-15',
        asOfDateApproximate: false,
        concept: 'Saldo migrado',
        importBatchId: 'batch-1',
        ...overrides,
      };
    }

    it('suma al saldo de su moneda sin tocar lo presupuestado ni lo abonado', () => {
      const out = computeAccountStatement(
        snapshot({
          plans: [plan('tp-1', { billable: 1000 })],
          payments: [payment('tp-1', 300)],
          openingBalances: [opening('ob-1', 250.5)],
        }),
        { today: TODAY },
      );
      expect(out.summary).toEqual([
        {
          currency: 'COP',
          budgeted: 1000,
          openingBalance: 250.5,
          openingPending: 250.5,
          paid: 300,
          creditMovements: 0,
          balance: 950.5,
          overdueCount: 0,
          overdueAmount: 0,
          nextInstallment: null,
        },
      ]);
      expect(out.openingBalances).toEqual([
        {
          id: 'ob-1',
          currency: 'COP',
          amount: 250.5,
          asOfDate: '2025-12-15',
          asOfDateApproximate: false,
          concept: 'Saldo migrado',
          importBatchId: 'batch-1',
          paid: 0,
          pending: 250.5,
        },
      ]);
    });

    it('un paciente que solo tiene saldo migrado: una moneda por saldo, sin mezclar', () => {
      const out = computeAccountStatement(
        snapshot({
          openingBalances: [
            opening('ob-usd', 40, {
              currency: 'USD',
              asOfDateApproximate: true,
            }),
            opening('ob-cop', 150000),
          ],
        }),
        { today: TODAY },
      );
      expect(
        out.summary.map((s) => [s.currency, s.openingBalance, s.balance]),
      ).toEqual([
        ['COP', 150000, 150000],
        ['USD', 40, 40],
      ]);
      // Del más antiguo al más reciente y, a igual fecha, por moneda.
      expect(out.openingBalances.map((o) => o.id)).toEqual([
        'ob-cop',
        'ob-usd',
      ]);
    });

    it('los abonos contra el saldo migrado lo reducen: abonado y pendiente por saldo (revisión C1)', () => {
      const out = computeAccountStatement(
        snapshot({
          plans: [plan('tp-1', { billable: 1000 })],
          payments: [
            payment('tp-1', 300),
            {
              ...payment('tp-1', 50000),
              treatmentPlanId: null,
              openingBalanceId: 'ob-1',
            },
            {
              ...payment('tp-1', 1000),
              treatmentPlanId: null,
              openingBalanceId: 'ob-1',
              voidedAt: new Date('2026-02-02T00:00:00.000Z'),
            },
          ],
          openingBalances: [opening('ob-1', 150000)],
        }),
        { today: TODAY },
      );
      expect(out.openingBalances[0]).toMatchObject({
        id: 'ob-1',
        amount: 150000,
        paid: 50000,
        pending: 100000,
      });
      expect(out.summary[0]).toMatchObject({
        budgeted: 1000,
        openingBalance: 150000,
        // Lo que queda del migrado, para «Incluye saldo migrado» (QA D5).
        openingPending: 100000,
        paid: 50300,
        balance: 100700,
      });
      // El abono al saldo migrado no cubre el plan ni sus cuotas.
      expect(out.plans[0]).toMatchObject({ paid: 300, balance: 700 });
      expect(out.movements.find((m) => m.amount === 50000)).toMatchObject({
        treatmentPlanId: null,
        openingBalanceId: 'ob-1',
      });
    });
  });
});

describe('computeAccountStatement — saldo a favor (DX-253)', () => {
  const cancelled = plan('origen', { status: 'CANCELLED', billable: 500_000 });
  const live = plan('destino', { billable: 400_000 });

  it('traspaso: el origen cancelado queda con 100.000 a favor y el destino baja 200.000, sin tocar los abonos', () => {
    const paid = payment('origen', 300_000);
    const out = computeAccountStatement(
      snapshot({
        plans: [cancelled, live],
        payments: [paid],
        creditEntries: [
          { treatmentPlanId: 'origen', currency: 'COP', amount: -200_000 },
          { treatmentPlanId: 'destino', currency: 'COP', amount: 200_000 },
        ],
      }),
      { today: TODAY },
    );
    const origin = out.plans.find((p) => p.id === 'origen')!;
    const target = out.plans.find((p) => p.id === 'destino')!;
    expect(origin).toMatchObject({
      paid: 300_000,
      creditMovements: -200_000,
      balance: -100_000,
    });
    expect(target).toMatchObject({
      paid: 0,
      creditMovements: 200_000,
      balance: 200_000,
    });
    // Los abonos no cambian: el único movimiento sigue siendo el original.
    expect(out.movements.map((m) => [m.id, m.amount])).toEqual([
      [paid.id, 300_000],
    ]);
    // Traspaso dentro del paciente: el saldo total no cambia (400.000 − 300.000).
    expect(out.summary[0]).toMatchObject({
      currency: 'COP',
      paid: 300_000,
      creditMovements: 0,
      balance: 100_000,
    });
  });

  it('devolución: el saldo a favor baja y el resumen la resta', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [cancelled],
        payments: [payment('origen', 300_000)],
        creditEntries: [
          { treatmentPlanId: 'origen', currency: 'COP', amount: -300_000 },
        ],
      }),
      { today: TODAY },
    );
    expect(out.plans[0].balance).toBe(0);
    expect(out.summary[0]).toMatchObject({
      paid: 300_000,
      creditMovements: -300_000,
      balance: 0,
    });
  });

  it('una anulación sigue sin sumar y el traspaso recibido cubre cuotas', () => {
    const out = computeAccountStatement(
      snapshot({
        plans: [plan('p', { billable: 300 })],
        payments: [payment('p', 50, { voidedAt: TODAY })],
        paymentPlans: [paymentPlan('p')],
        creditEntries: [{ treatmentPlanId: 'p', currency: 'COP', amount: 100 }],
      }),
      { today: TODAY },
    );
    expect(out.plans[0]).toMatchObject({ paid: 0, balance: 200 });
    expect(out.installments.map((i) => i.status)).toEqual([
      'PAID',
      'OVERDUE',
      'PENDING',
    ]);
  });
});
