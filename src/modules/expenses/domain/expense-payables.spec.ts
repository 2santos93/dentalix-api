import { assemblePayables } from './expense-payables';
import type { PayableSupplierRow } from './ports/expense-payables-repository.port';

const ZERO = {
  openCount: 1,
  pendingCents: 0,
  overdueCount: 0,
  overdueCents: 0,
  dueIn7DaysCount: 0,
  dueIn7DaysCents: 0,
  dueIn30DaysCount: 0,
  dueIn30DaysCents: 0,
  noDueDateCount: 0,
  noDueDateCents: 0,
};

const row = (patch: Partial<PayableSupplierRow>): PayableSupplierRow => ({
  supplierKey: 'x',
  supplier: 'X',
  currency: 'USD',
  oldestDueDate: null,
  ...ZERO,
  ...patch,
});

describe('cuentas por pagar: ensamblado (DX-411)', () => {
  it('pasa céntimos a importes y totaliza por moneda sin mezclarlas', () => {
    const { rows, totals } = assemblePayables([
      row({
        supplierKey: 'laboratorio avila',
        supplier: 'Laboratorio Ávila',
        pendingCents: 12_050,
        overdueCount: 1,
        overdueCents: 5_000,
        dueIn7DaysCount: 1,
        dueIn7DaysCents: 7_050,
        dueIn30DaysCount: 1,
        dueIn30DaysCents: 7_050,
        openCount: 2,
        oldestDueDate: '2026-11-01',
      }),
      row({
        supplierKey: 'depósito',
        supplier: 'Depósito',
        pendingCents: 1_000,
        noDueDateCount: 1,
        noDueDateCents: 1_000,
      }),
      row({
        supplierKey: 'laboratorio avila',
        supplier: 'Laboratorio Ávila',
        currency: 'VES',
        pendingCents: 3_650_000,
        dueIn30DaysCount: 1,
        dueIn30DaysCents: 3_650_000,
        oldestDueDate: '2026-11-25',
      }),
    ]);
    expect(rows[0]).toEqual({
      supplierKey: 'laboratorio avila',
      supplier: 'Laboratorio Ávila',
      currency: 'USD',
      oldestDueDate: '2026-11-01',
      openCount: 2,
      pending: 120.5,
      overdueCount: 1,
      overdue: 50,
      dueIn7DaysCount: 1,
      dueIn7Days: 70.5,
      dueIn30DaysCount: 1,
      dueIn30Days: 70.5,
      noDueDateCount: 0,
      noDueDate: 0,
    });
    expect(totals).toEqual([
      {
        currency: 'USD',
        openCount: 3,
        pending: 130.5,
        overdueCount: 1,
        overdue: 50,
        dueIn7DaysCount: 1,
        dueIn7Days: 70.5,
        dueIn30DaysCount: 1,
        dueIn30Days: 70.5,
        noDueDateCount: 1,
        noDueDate: 10,
      },
      {
        currency: 'VES',
        openCount: 1,
        pending: 36_500,
        overdueCount: 0,
        overdue: 0,
        dueIn7DaysCount: 0,
        dueIn7Days: 0,
        dueIn30DaysCount: 1,
        dueIn30Days: 36_500,
        noDueDateCount: 0,
        noDueDate: 0,
      },
    ]);
  });

  it('ordena por el vencimiento más antiguo, sin vencimiento y «Sin proveedor» al final', () => {
    const { rows } = assemblePayables([
      row({ supplierKey: '', supplier: null, oldestDueDate: null }),
      row({ supplierKey: 'zeta', supplier: 'Zeta', oldestDueDate: null }),
      row({
        supplierKey: 'beta',
        supplier: 'Beta',
        oldestDueDate: '2026-12-01',
      }),
      row({ supplierKey: '', supplier: null, oldestDueDate: '2026-10-01' }),
      row({ supplierKey: 'alfa', supplier: 'Alfa', oldestDueDate: null }),
      row({
        supplierKey: 'beta',
        supplier: 'Beta',
        currency: 'EUR',
        oldestDueDate: '2026-12-01',
      }),
    ]);
    expect(rows.map((r) => [r.supplier, r.currency, r.oldestDueDate])).toEqual([
      [null, 'USD', '2026-10-01'],
      ['Beta', 'EUR', '2026-12-01'],
      ['Beta', 'USD', '2026-12-01'],
      ['Alfa', 'USD', null],
      ['Zeta', 'USD', null],
      [null, 'USD', null],
    ]);
  });

  it('sin gastos abiertos: sin filas ni totales', () => {
    expect(assemblePayables([])).toEqual({ rows: [], totals: [] });
  });
});
