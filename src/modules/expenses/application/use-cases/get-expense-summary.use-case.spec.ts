import { BadRequestException } from '@nestjs/common';
import type {
  ExpenseSummaryData,
  ExpenseSummaryQuery,
  ExpenseSummaryRepository,
} from '../../domain/ports/expense-summary-repository.port';
import {
  GetExpenseSummaryUseCase,
  SUMMARY_PERIOD_INVALID_MESSAGE,
  SUMMARY_PERIOD_TOO_LONG_MESSAGE,
} from './get-expense-summary.use-case';

const NORTE = '22222222-2222-4222-8222-222222222222';
const SUR = '33333333-3333-4333-8333-333333333333';

class FakeSummaryRepo implements ExpenseSummaryRepository {
  last: ExpenseSummaryQuery | null = null;
  data: ExpenseSummaryData = {
    locationNames: new Map([
      [NORTE, 'Norte'],
      [SUR, 'Sur'],
    ]),
    income: [],
    expenses: [],
  };

  summarize(query: ExpenseSummaryQuery): Promise<ExpenseSummaryData> {
    this.last = query;
    return Promise.resolve(this.data);
  }
}

describe('resumen mensual de gastos (DX-274)', () => {
  let repo: FakeSummaryRepo;
  let summary: GetExpenseSummaryUseCase;

  beforeEach(() => {
    repo = new FakeSummaryRepo();
    summary = new GetExpenseSummaryUseCase(repo);
  });

  const range = { from: '2026-09-01', to: '2026-10-31' };

  it('une ingresos y gastos por mes, sede y moneda, con neto', async () => {
    repo.data.income = [
      { month: '2026-10', locationId: NORTE, currency: 'COP', cents: 500000 },
      { month: '2026-10', locationId: NORTE, currency: 'USD', cents: 1050 },
    ];
    repo.data.expenses = [
      {
        month: '2026-10',
        locationId: NORTE,
        currency: 'COP',
        category: 'Arriendo',
        cents: 300000,
      },
      {
        month: '2026-10',
        locationId: NORTE,
        currency: 'COP',
        category: 'Papelería',
        cents: 25050,
      },
    ];
    const { rows } = await summary.execute(range);
    expect(rows).toEqual([
      {
        month: '2026-10',
        locationId: NORTE,
        locationName: 'Norte',
        currency: 'COP',
        income: 5000,
        categories: [
          { category: 'Arriendo', amount: 3000 },
          { category: 'Papelería', amount: 250.5 },
        ],
        expensesTotal: 3250.5,
        net: 1749.5,
      },
      {
        month: '2026-10',
        locationId: NORTE,
        locationName: 'Norte',
        currency: 'USD',
        income: 10.5,
        categories: [],
        expensesTotal: 0,
        net: 10.5,
      },
    ]);
  });

  it('un mes solo con gastos queda con ingresos 0 y neto negativo', async () => {
    repo.data.expenses = [
      {
        month: '2026-09',
        locationId: SUR,
        currency: 'COP',
        category: 'Otros',
        cents: 10000,
      },
    ];
    const { rows } = await summary.execute(range);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ income: 0, expensesTotal: 100, net: -100 });
  });

  it('ordena por mes, sede y moneda y las categorías de mayor a menor', async () => {
    repo.data.income = [
      { month: '2026-10', locationId: NORTE, currency: 'COP', cents: 1 },
      { month: '2026-09', locationId: SUR, currency: 'COP', cents: 1 },
      { month: '2026-09', locationId: NORTE, currency: 'USD', cents: 1 },
      { month: '2026-09', locationId: NORTE, currency: 'COP', cents: 1 },
    ];
    repo.data.expenses = [
      {
        month: '2026-09',
        locationId: SUR,
        currency: 'COP',
        category: 'B',
        cents: 5,
      },
      {
        month: '2026-09',
        locationId: SUR,
        currency: 'COP',
        category: 'A',
        cents: 5,
      },
      {
        month: '2026-09',
        locationId: SUR,
        currency: 'COP',
        category: 'C',
        cents: 9,
      },
    ];
    const { rows } = await summary.execute(range);
    expect(
      rows.map((r) => `${r.month} ${r.locationName} ${r.currency}`),
    ).toEqual([
      '2026-09 Norte COP',
      '2026-09 Norte USD',
      '2026-09 Sur COP',
      '2026-10 Norte COP',
    ]);
    expect(rows[2].categories.map((c) => c.category)).toEqual(['C', 'A', 'B']);
  });

  it('suma en céntimos: sin errores de coma flotante', async () => {
    repo.data.expenses = [
      {
        month: '2026-10',
        locationId: NORTE,
        currency: 'USD',
        category: 'A',
        cents: 10,
      },
      {
        month: '2026-10',
        locationId: NORTE,
        currency: 'USD',
        category: 'B',
        cents: 20,
      },
    ];
    const { rows } = await summary.execute(range);
    expect(rows[0].expensesTotal).toBe(0.3);
    expect(rows[0].net).toBe(-0.3);
  });

  it('pasa la sede pedida al repositorio', async () => {
    await summary.execute({ ...range, locationId: SUR });
    expect(repo.last).toEqual({ ...range, locationId: SUR });
  });

  it.each([
    [{ from: undefined, to: '2026-10-31' }],
    [{ from: '2026-10-31', to: '2026-10-01' }],
    [{ from: '2026-02-30', to: '2026-03-31' }],
    [{ from: 'ayer', to: 'hoy' }],
  ])('periodo no válido %j → 400', async (input) => {
    await expect(summary.execute(input)).rejects.toThrow(
      new BadRequestException(SUMMARY_PERIOD_INVALID_MESSAGE),
    );
  });

  it('366 días valen; 367 no', async () => {
    await expect(
      summary.execute({ from: '2026-01-01', to: '2027-01-01' }),
    ).resolves.toBeDefined();
    await expect(
      summary.execute({ from: '2026-01-01', to: '2027-01-02' }),
    ).rejects.toThrow(new BadRequestException(SUMMARY_PERIOD_TOO_LONG_MESSAGE));
  });
});
