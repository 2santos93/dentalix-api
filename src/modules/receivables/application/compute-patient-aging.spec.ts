import { computeBalances } from '../../account-statement/application/compute-account-statement';
import type { StatementPaymentPlanRow } from '../../account-statement/domain/entities/account-statement.entity';
import type {
  AgingPlanRow,
  PatientLedger,
} from '../domain/entities/receivables.entity';
import { computePatientAging } from './compute-patient-aging';

// 15:00 UTC = 10:00 en Bogotá: el mismo día civil en las dos zonas.
const NOW = new Date('2026-10-17T15:00:00.000Z');
const BOGOTA = 'America/Bogota';

function plan(id: string, overrides: Partial<AgingPlanRow> = {}): AgingPlanRow {
  return {
    id,
    status: 'ACCEPTED',
    currency: 'COP',
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    billable: 0,
    agingFrom: new Date('2026-10-17T12:00:00.000Z'),
    ...overrides,
  };
}

function schedule(
  treatmentPlanId: string,
  dues: [string, number][],
  overrides: Partial<StatementPaymentPlanRow> = {},
): StatementPaymentPlanRow {
  return {
    id: `pp-${treatmentPlanId}`,
    treatmentPlanId,
    currency: 'COP',
    status: 'ACTIVE',
    downPayment: 0,
    startDate: new Date(`${dues[0][0]}T00:00:00.000Z`),
    installments: dues.map(([day, amount], i) => ({
      sequence: i + 1,
      dueDate: new Date(`${day}T00:00:00.000Z`),
      amount,
    })),
    ...overrides,
  };
}

function ledger(overrides: Partial<PatientLedger> = {}): PatientLedger {
  return {
    patientId: 'pat-1',
    locationId: 'loc-1',
    plans: [],
    paid: [],
    paymentPlans: [],
    ...overrides,
  };
}

describe('computePatientAging', () => {
  it('reparte la semilla del criterio de aceptación: 10 días, 75 días y saldo sin cuotas de hace 120', () => {
    const aging = computePatientAging(
      ledger({
        plans: [
          plan('cuotas', { billable: 300000 }),
          plan('sin-cuotas', {
            billable: 500000,
            agingFrom: new Date('2026-06-19T17:00:00.000Z'),
          }),
        ],
        paymentPlans: [
          schedule('cuotas', [
            ['2026-08-03', 100000], // hace 75 días
            ['2026-10-07', 100000], // hace 10 días
            ['2026-11-07', 100000], // por vencer
          ]),
        ],
      }),
      { now: NOW, timeZone: BOGOTA },
    );

    expect(aging.currencies).toEqual([
      {
        currency: 'COP',
        balance: 800000,
        debt: 800000,
        credit: 0,
        buckets: {
          current: 100000,
          days0to30: 100000,
          days31to60: 0,
          days61to90: 100000,
          over90: 500000,
        },
        oldestAgeDays: 120,
        ageApproximate: true,
        nextInstallment: {
          dueDate: new Date('2026-11-07T00:00:00.000Z'),
          amount: 100000,
        },
      },
    ]);
    expect(aging.oldestAgeDays).toBe(120);
    expect(aging.ageApproximate).toBe(true);
  });

  it.each([
    ['2026-09-17', 30, 'days0to30'],
    ['2026-09-16', 31, 'days31to60'],
    ['2026-08-18', 60, 'days31to60'],
    ['2026-08-17', 61, 'days61to90'],
    ['2026-07-19', 90, 'days61to90'],
    ['2026-07-18', 91, 'over90'],
  ] as const)(
    'una cuota vencida el %s (%i días) cae en %s',
    (dueDay, age, bucket) => {
      const aging = computePatientAging(
        ledger({
          plans: [plan('p', { billable: 100 })],
          paymentPlans: [schedule('p', [[dueDay, 100]])],
        }),
        { now: NOW, timeZone: BOGOTA },
      );
      const [cop] = aging.currencies;
      expect(cop.buckets[bucket]).toBe(100);
      expect(cop.oldestAgeDays).toBe(age);
      // Una cuota tiene fecha cierta: no es aproximada.
      expect(cop.ageApproximate).toBe(false);
    },
  );

  it('cuenta «hoy» en la zona de la sede: a las 22:00 de Bogotá aún no venció la cuota de ese día', () => {
    // 03:00 UTC del 17 = 22:00 del 16 en Bogotá = 05:00 del 17 en Madrid.
    const now = new Date('2026-10-17T03:00:00.000Z');
    const input = ledger({
      plans: [plan('p', { billable: 100 })],
      paymentPlans: [schedule('p', [['2026-10-16', 100]])],
    });

    const bogota = computePatientAging(input, { now, timeZone: BOGOTA });
    expect(bogota.currencies[0].buckets.current).toBe(100);
    expect(bogota.currencies[0].oldestAgeDays).toBeNull();

    const madrid = computePatientAging(input, {
      now,
      timeZone: 'Europe/Madrid',
    });
    expect(madrid.currencies[0].buckets.days0to30).toBe(100);
    expect(madrid.currencies[0].oldestAgeDays).toBe(1);
  });

  it('la fecha del saldo sin cuotas es el día civil de la sede (aceptado a las 21:00 de Bogotá)', () => {
    const aging = computePatientAging(
      ledger({
        plans: [
          plan('p', {
            billable: 100,
            // 02:00 UTC del 18-sep = 21:00 del 17-sep en Bogotá.
            agingFrom: new Date('2026-09-18T02:00:00.000Z'),
          }),
        ],
      }),
      { now: NOW, timeZone: BOGOTA },
    );
    expect(aging.currencies[0].oldestAgeDays).toBe(30);
    expect(aging.currencies[0].buckets.days0to30).toBe(100);
  });

  it('el saldo a favor va aparte y NUNCA se resta de los tramos', () => {
    const aging = computePatientAging(
      ledger({
        plans: [
          plan('debe', {
            billable: 1000,
            agingFrom: new Date('2026-05-01T12:00:00.000Z'),
          }),
          plan('pagado-de-mas', { billable: 200 }),
        ],
        paid: [
          { treatmentPlanId: 'pagado-de-mas', currency: 'COP', amount: 450 },
        ],
      }),
      { now: NOW, timeZone: BOGOTA },
    );
    const [cop] = aging.currencies;
    expect(cop.buckets.over90).toBe(1000);
    expect(cop.debt).toBe(1000);
    expect(cop.credit).toBe(250);
    // Saldo neto = el del estado de cuenta.
    expect(cop.balance).toBe(750);
  });

  it('un plan cancelado con abonos deja saldo a favor, como en el estado de cuenta', () => {
    const aging = computePatientAging(
      ledger({
        plans: [plan('cancelado', { status: 'CANCELLED', billable: 500 })],
        paid: [{ treatmentPlanId: 'cancelado', currency: 'COP', amount: 50 }],
      }),
      { now: NOW, timeZone: BOGOTA },
    );
    expect(aging.currencies).toEqual([
      expect.objectContaining({ debt: 0, credit: 50, balance: -50 }),
    ]);
    expect(aging.oldestAgeDays).toBeNull();
  });

  it('separa las monedas sin convertir; un abono en otra moneda es saldo a favor en esa moneda', () => {
    const aging = computePatientAging(
      ledger({
        plans: [
          plan('cop', { billable: 300000 }),
          plan('usd', {
            currency: 'USD',
            billable: 200,
            agingFrom: new Date('2026-08-01T12:00:00.000Z'),
          }),
        ],
        paid: [
          { treatmentPlanId: 'cop', currency: 'COP', amount: 100000 },
          { treatmentPlanId: 'cop', currency: 'USD', amount: 20 },
        ],
      }),
      { now: NOW, timeZone: BOGOTA },
    );
    expect(
      aging.currencies.map((c) => [c.currency, c.debt, c.credit, c.balance]),
    ).toEqual([
      ['COP', 200000, 0, 200000],
      ['USD', 200, 20, 180],
    ]);
    expect(aging.currencies[1].buckets.days61to90).toBe(200);
  });

  it('el total de cada moneda es el saldo de computeBalances (el del estado de cuenta)', () => {
    const input = ledger({
      plans: [
        plan('a', { billable: 1000 }),
        plan('b', { billable: 50, status: 'COMPLETED' }),
        plan('c', { billable: 300, status: 'REJECTED' }),
      ],
      paid: [
        { treatmentPlanId: 'a', currency: 'COP', amount: 300 },
        { treatmentPlanId: 'b', currency: 'COP', amount: 80 },
        { treatmentPlanId: 'c', currency: 'COP', amount: 10 },
      ],
      paymentPlans: [
        schedule('a', [
          ['2026-09-01', 350],
          ['2026-12-01', 350],
        ]),
      ],
    });
    const aging = computePatientAging(input, { now: NOW, timeZone: BOGOTA });
    const balances = computeBalances(
      {
        plans: input.plans,
        payments: input.paid.map((p) => ({ ...p, voidedAt: null })),
        paymentPlans: input.paymentPlans,
      },
      NOW,
    );
    expect(aging.currencies[0].balance).toBe(balances.summary[0].balance);
    const [cop] = aging.currencies;
    const bucketSum = Object.values(cop.buckets).reduce((s, v) => s + v, 0);
    expect(bucketSum).toBe(cop.debt);
    expect(cop.debt - cop.credit).toBe(cop.balance);
  });

  it('si las cuotas superan el saldo del plan, solo envejece el saldo, desde las cuotas más antiguas', () => {
    const aging = computePatientAging(
      ledger({
        // Plan de 150, calendario de 3 × 100 (se retiró un ítem después).
        plans: [plan('p', { billable: 150 })],
        paymentPlans: [
          schedule('p', [
            ['2026-06-01', 100],
            ['2026-09-01', 100],
            ['2026-12-01', 100],
          ]),
        ],
      }),
      { now: NOW, timeZone: BOGOTA },
    );
    expect(aging.currencies[0].buckets).toEqual({
      current: 0,
      days0to30: 0,
      days31to60: 50,
      days61to90: 0,
      over90: 100,
    });
    expect(aging.currencies[0].debt).toBe(150);
  });

  it('lo que el plan de pagos no financia envejece desde la fecha del plan, marcado como aproximado', () => {
    const aging = computePatientAging(
      ledger({
        plans: [
          plan('p', {
            billable: 1000,
            agingFrom: new Date('2026-07-01T12:00:00.000Z'),
          }),
        ],
        paymentPlans: [schedule('p', [['2026-10-01', 400]])],
      }),
      { now: NOW, timeZone: BOGOTA },
    );
    expect(aging.currencies[0].buckets).toMatchObject({
      days0to30: 400,
      over90: 600,
    });
    expect(aging.currencies[0].ageApproximate).toBe(true);
  });

  it('la cuota cubierta por los abonos no cuenta (mismo reparto voraz que el estado de cuenta)', () => {
    const aging = computePatientAging(
      ledger({
        plans: [plan('p', { billable: 300 })],
        paid: [{ treatmentPlanId: 'p', currency: 'COP', amount: 150 }],
        paymentPlans: [
          schedule('p', [
            ['2026-06-01', 100],
            ['2026-09-01', 100],
            ['2026-12-01', 100],
          ]),
        ],
      }),
      { now: NOW, timeZone: BOGOTA },
    );
    expect(aging.currencies[0].buckets).toMatchObject({
      over90: 0,
      days31to60: 50,
      current: 100,
    });
    expect(aging.currencies[0].oldestAgeDays).toBe(46);
  });

  it('un paciente al día no tiene monedas', () => {
    const aging = computePatientAging(
      ledger({
        plans: [plan('p', { billable: 100 })],
        paid: [{ treatmentPlanId: 'p', currency: 'COP', amount: 100 }],
      }),
      { now: NOW, timeZone: BOGOTA },
    );
    expect(aging.currencies).toEqual([]);
  });
});
