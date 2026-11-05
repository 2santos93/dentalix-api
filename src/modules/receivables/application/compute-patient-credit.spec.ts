import {
  computeAccountStatement,
  type PlanBalances,
} from '../../account-statement/application/compute-account-statement';
import type {
  BalanceCreditRow,
  StatementPaymentRow,
  StatementPlanRow,
} from '../../account-statement/domain/entities/account-statement.entity';
import type { GetPlanBalanceResult } from '../../payments/application/use-cases/get-plan-balance.use-case';
import { toCents, fromCents } from '../domain/aging';
import type { PatientLedger } from '../domain/entities/receivables.entity';
import { computePatientCredit } from './compute-patient-credit';

const NOW = new Date('2026-11-03T15:00:00.000Z');

/**
 * Un paciente de prueba en la forma del ESTADO DE CUENTA (abonos sueltos y
 * asientos del saldo a favor). De él salen las dos lecturas que DX-430 exige
 * iguales: el estado de cuenta y el resumen de la cartera.
 */
interface World {
  plans: StatementPlanRow[];
  payments: Pick<
    StatementPaymentRow,
    'id' | 'treatmentPlanId' | 'amount' | 'currency' | 'voidedAt'
  >[];
  entries: BalanceCreditRow[];
  planBalances?: PlanBalances;
}

function plan(
  id: string,
  status: StatementPlanRow['status'],
  billable: number,
  currency = 'USD',
): StatementPlanRow {
  return {
    id,
    status,
    currency,
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    billable,
  };
}

function pay(
  id: string,
  treatmentPlanId: string,
  amount: number,
  currency = 'USD',
  voidedAt: Date | null = null,
): World['payments'][number] {
  return { id, treatmentPlanId, amount, currency, voidedAt };
}

/** Lo que la BD guarda en `patient_ledgers`: sumas por plan, con los asientos dentro de lo abonado. */
function ledgerOf(world: World): PatientLedger {
  const plans = world.plans.map((p) => ({ ...p, agingFrom: p.createdAt }));
  const paid: PatientLedger['paid'] = [];
  for (const p of world.plans) {
    const own = world.payments
      .filter(
        (x) =>
          x.treatmentPlanId === p.id &&
          x.voidedAt === null &&
          x.currency === p.currency,
      )
      .reduce((s, x) => s + toCents(x.amount), 0);
    const net = world.entries
      .filter((e) => e.treatmentPlanId === p.id && e.currency === p.currency)
      .reduce((s, e) => s + toCents(e.amount), 0);
    if (own + net !== 0) {
      paid.push({
        treatmentPlanId: p.id,
        currency: p.currency,
        amount: fromCents(own + net),
      });
    }
    // Los abonos en otra moneda van aparte, sin sumar a la del plan.
    for (const x of world.payments.filter(
      (y) =>
        y.treatmentPlanId === p.id &&
        y.voidedAt === null &&
        y.currency !== p.currency,
    )) {
      paid.push({
        treatmentPlanId: p.id,
        currency: x.currency,
        amount: x.amount,
      });
    }
  }
  return {
    patientId: 'pat-1',
    locationId: 'loc-1',
    plans,
    paid,
    paymentPlans: [],
  };
}

/** Lo que el ESTADO DE CUENTA dice a favor, por moneda: `-balance` de los planes con saldo < 0. */
function creditInStatement(world: World): Record<string, number> {
  const statement = computeAccountStatement(
    {
      plans: world.plans,
      payments: world.payments.map((p) => ({
        ...p,
        paidAt: new Date('2026-10-01T15:00:00.000Z'),
        timeZone: 'America/Caracas',
        method: 'CASH',
        paymentMethod: null,
        reference: null,
        location: { id: 'loc-1', name: 'Sede Norte' },
        createdById: 'u-1',
        voidedBy: null,
        voidReason: null,
      })) as unknown as StatementPaymentRow[],
      paymentPlans: [],
      creditEntries: world.entries,
    },
    { today: NOW, planBalances: world.planBalances },
  );
  const out: Record<string, number> = {};
  for (const line of statement.plans) {
    if (line.balance < 0) {
      out[line.currency] = fromCents(
        toCents(out[line.currency] ?? 0) - toCents(line.balance),
      );
    }
  }
  return out;
}

function creditInList(world: World): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of computePatientCredit(ledgerOf(world), {
    now: NOW,
    planBalances: world.planBalances,
  })) {
    out[c.currency] = fromCents(c.creditCents);
  }
  return out;
}

function known(
  overrides: Partial<GetPlanBalanceResult> &
    Pick<GetPlanBalanceResult, 'planCurrency' | 'billable' | 'paid'>,
): GetPlanBalanceResult {
  return {
    balance: overrides.billable - overrides.paid,
    creditMovements: 0,
    paymentsCount: 1,
    paymentsWithoutRate: [],
    rateProviderTimedOut: false,
    ...overrides,
  };
}

describe('computePatientCredit (DX-430)', () => {
  const worlds: Record<string, World> = {
    'plan vivo pagado de más': {
      plans: [plan('a', 'ACCEPTED', 100)],
      payments: [pay('1', 'a', 130)],
      entries: [],
    },
    'plan vivo justo pagado y otro con deuda: no se compensan': {
      plans: [plan('a', 'ACCEPTED', 100), plan('b', 'ACCEPTED', 500)],
      payments: [pay('1', 'a', 160), pay('2', 'b', 50)],
      entries: [],
    },
    'plan cancelado con abonos: todo a favor': {
      plans: [plan('a', 'CANCELLED', 300)],
      payments: [pay('1', 'a', 300)],
      entries: [],
    },
    'plan rechazado con abonos': {
      plans: [plan('a', 'REJECTED', 80)],
      payments: [pay('1', 'a', 25)],
      entries: [],
    },
    'abono anulado no cuenta': {
      plans: [plan('a', 'CANCELLED', 300)],
      payments: [
        pay('1', 'a', 300, 'USD', new Date('2026-10-02T00:00:00.000Z')),
        pay('2', 'a', 40),
      ],
      entries: [],
    },
    'traspaso parcial: el origen conserva lo que no salió': {
      plans: [plan('a', 'CANCELLED', 300), plan('b', 'ACCEPTED', 500)],
      payments: [pay('1', 'a', 300)],
      entries: [
        { treatmentPlanId: 'a', currency: 'USD', amount: -200 },
        { treatmentPlanId: 'b', currency: 'USD', amount: 200 },
      ],
    },
    'traspaso total: el paciente no tiene a favor': {
      plans: [plan('a', 'CANCELLED', 300), plan('b', 'ACCEPTED', 500)],
      payments: [pay('1', 'a', 300)],
      entries: [
        { treatmentPlanId: 'a', currency: 'USD', amount: -300 },
        { treatmentPlanId: 'b', currency: 'USD', amount: 300 },
      ],
    },
    'devolución parcial': {
      plans: [plan('a', 'CANCELLED', 300)],
      payments: [pay('1', 'a', 300)],
      entries: [{ treatmentPlanId: 'a', currency: 'USD', amount: -120 }],
    },
    'devolución total: desaparece': {
      plans: [plan('a', 'CANCELLED', 300)],
      payments: [pay('1', 'a', 300)],
      entries: [{ treatmentPlanId: 'a', currency: 'USD', amount: -300 }],
    },
    'traspaso recibido que sobra del destino': {
      plans: [plan('a', 'CANCELLED', 300), plan('b', 'ACCEPTED', 100)],
      payments: [pay('1', 'a', 300)],
      entries: [
        { treatmentPlanId: 'a', currency: 'USD', amount: -300 },
        { treatmentPlanId: 'b', currency: 'USD', amount: 300 },
      ],
    },
    'varias monedas: VES y USD por separado': {
      plans: [
        plan('a', 'ACCEPTED', 100, 'USD'),
        plan('b', 'ACCEPTED', 2000, 'VES'),
        plan('c', 'CANCELLED', 1000, 'VES'),
      ],
      payments: [
        pay('1', 'a', 110, 'USD'),
        pay('2', 'b', 2500, 'VES'),
        pay('3', 'c', 400, 'VES'),
      ],
      entries: [],
    },
    'abono en otra moneda convertido a la del plan': {
      plans: [plan('a', 'ACCEPTED', 100, 'USD')],
      payments: [pay('1', 'a', 5400, 'VES')],
      entries: [],
      planBalances: new Map([
        ['a', known({ planCurrency: 'USD', billable: 100, paid: 120 })],
      ]),
    },
    'sin planes ni abonos': { plans: [], payments: [], entries: [] },
  };

  it.each(Object.entries(worlds))(
    'da lo mismo que el estado de cuenta: %s',
    (_name, world) => {
      expect(creditInList(world)).toEqual(creditInStatement(world));
    },
  );

  it('suma, por moneda, lo que sobra de cada plan y nombra los planes que lo originan', () => {
    const world =
      worlds['plan vivo justo pagado y otro con deuda: no se compensan'];
    const credit = computePatientCredit(ledgerOf(world), { now: NOW });
    expect(credit).toEqual([
      { currency: 'USD', creditCents: 6000, planIds: ['a'] },
    ]);
  });

  it('un traspaso o una devolución total lo quita de la lista', () => {
    for (const name of [
      'traspaso total: el paciente no tiene a favor',
      'devolución total: desaparece',
    ]) {
      expect(
        computePatientCredit(ledgerOf(worlds[name]), { now: NOW }),
      ).toEqual([]);
    }
  });

  it('un residuo de conversión que la moneda no tiene no es saldo a favor (B4)', () => {
    const world: World = {
      plans: [plan('a', 'ACCEPTED', 100, 'JPY')],
      payments: [],
      entries: [],
      planBalances: new Map([
        [
          'a',
          known({
            planCurrency: 'JPY',
            billable: 100,
            paid: 100.13,
            balance: -0.13,
          }),
        ],
      ]),
    };
    expect(
      computePatientCredit(ledgerOf(world), {
        now: NOW,
        planBalances: world.planBalances,
        roundingDigitsOf: () => 0,
      }),
    ).toEqual([]);
  });
});
