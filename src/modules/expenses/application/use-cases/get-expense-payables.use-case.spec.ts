import type { Expense } from '../../domain/entities/expense.entity';
import type {
  ExpensePayablesRepository,
  PayableExpenses,
  PayableExpensesQuery,
  PayableSupplierRow,
  PayablesQuery,
} from '../../domain/ports/expense-payables-repository.port';
import type { ExpenseRepository } from '../../domain/ports/expense-repository.port';
import { PAYABLE_EXPENSES_LIMIT } from '../../domain/expense-payables';
import { GetExpensePayablesUseCase } from './get-expense-payables.use-case';

const NOW = new Date('2026-11-10T15:00:00.000Z');
const USER = '44444444-4444-4444-8444-444444444444';

class FakePayablesRepo implements ExpensePayablesRepository {
  calls: { query: PayablesQuery | PayableExpensesQuery; now: Date }[] = [];
  rows: PayableSupplierRow[] = [];
  found: PayableExpenses = { items: [], total: 0 };

  payables(query: PayablesQuery, now: Date): Promise<PayableSupplierRow[]> {
    this.calls.push({ query, now });
    return Promise.resolve(this.rows);
  }

  payableExpenses(
    query: PayableExpensesQuery,
    now: Date,
  ): Promise<PayableExpenses> {
    this.calls.push({ query, now });
    return Promise.resolve(this.found);
  }
}

const expense = (patch: Partial<Expense>): Expense => ({
  id: '00000000-0000-4000-8000-000000000001',
  locationId: '22222222-2222-4222-8222-222222222222',
  category: 'Laboratorio',
  supplier: 'Laboratorio Ávila',
  description: null,
  amount: 100,
  currency: 'USD',
  invoiceDate: '2026-11-01',
  dueDate: '2026-11-12',
  attachment: null,
  createdById: USER,
  createdAt: new Date('2026-11-01T12:00:00Z'),
  updatedAt: new Date('2026-11-01T12:00:00Z'),
  voidedAt: null,
  voidedById: null,
  voidReason: null,
  paidAmount: 40,
  status: 'PARTIAL',
  overdue: false,
  ...patch,
});

describe('cuentas por pagar por proveedor (DX-411)', () => {
  let repo: FakePayablesRepo;
  let useCase: GetExpensePayablesUseCase;

  beforeEach(() => {
    repo = new FakePayablesRepo();
    const names = {
      userNames: () => Promise.resolve(new Map([[USER, 'Ana Pérez']])),
    } as unknown as ExpenseRepository;
    useCase = new GetExpensePayablesUseCase(repo, names, () => NOW);
  });

  it('pasa sede, moneda y el reloj al repositorio', async () => {
    await useCase.execute({ locationId: 'loc', currency: 'VES' });
    expect(repo.calls).toEqual([
      { query: { locationId: 'loc', currency: 'VES' }, now: NOW },
    ]);
  });

  it('detalle: con el tope, la grafía del gasto abierto más reciente y el pendiente de cada uno', async () => {
    repo.found = {
      total: 2,
      items: [
        expense({ supplier: 'LABORATORIO ÁVILA' }),
        expense({
          id: '00000000-0000-4000-8000-000000000002',
          supplier: 'Laboratorio  Avila',
          createdAt: new Date('2026-11-05T12:00:00Z'),
          dueDate: null,
          paidAmount: 0,
          status: 'PENDING',
        }),
      ],
    };
    const view = await useCase.expensesOf({
      supplierKey: 'laboratorio avila',
      currency: 'USD',
    });
    expect(repo.calls[0]).toEqual({
      query: {
        locationId: undefined,
        currency: 'USD',
        supplierKey: 'laboratorio avila',
        limit: PAYABLE_EXPENSES_LIMIT,
      },
      now: NOW,
    });
    expect(view.supplier).toBe('Laboratorio  Avila');
    expect(view.total).toBe(2);
    expect(view.items.map((i) => [i.pendingAmount, i.createdByName])).toEqual([
      [60, 'Ana Pérez'],
      [100, 'Ana Pérez'],
    ]);
  });

  it('detalle sin gastos: proveedor null y lista vacía', async () => {
    const view = await useCase.expensesOf({ supplierKey: '', currency: 'USD' });
    expect(view).toEqual({
      supplierKey: '',
      supplier: null,
      currency: 'USD',
      items: [],
      total: 0,
    });
  });
});
