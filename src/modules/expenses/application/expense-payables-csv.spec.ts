import { CSV_BOM } from '../../../shared/csv/csv-cells';
import {
  EXPENSE_PAYABLES_CSV_HEADER,
  toExpensePayablesCsv,
} from './expense-payables-csv';
import type { PayableSupplierView } from '../domain/expense-payables';

const base: PayableSupplierView = {
  supplierKey: '=lab',
  supplier: '=Lab',
  currency: 'USD',
  oldestDueDate: '2026-11-01',
  openCount: 3,
  pending: 120.5,
  overdueCount: 1,
  overdue: 50,
  dueIn7DaysCount: 1,
  dueIn7Days: 70.5,
  dueIn30DaysCount: 2,
  dueIn30Days: 70.5,
  noDueDateCount: 0,
  noDueDate: 0,
};

describe('CSV de cuentas por pagar (DX-411)', () => {
  it('BOM, CRLF, una línea por proveedor × moneda y celdas contra fórmulas', () => {
    const csv = toExpensePayablesCsv([
      base,
      {
        ...base,
        supplierKey: '',
        supplier: null,
        currency: 'JPY',
        oldestDueDate: null,
        openCount: 1,
        pending: 1000,
        overdueCount: 0,
        overdue: 0,
        dueIn7DaysCount: 0,
        dueIn7Days: 0,
        dueIn30DaysCount: 0,
        dueIn30Days: 0,
        noDueDateCount: 1,
        noDueDate: 1000,
      },
    ]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      EXPENSE_PAYABLES_CSV_HEADER.join(','),
      `"'=Lab",USD,3,120.50,50.00,1,70.50,1,70.50,2,0.00,2026-11-01`,
      `"Sin proveedor",JPY,1,1000,0,0,0,0,0,0,1000,`,
      '',
    ]);
  });

  it('sin filas: solo la cabecera', () => {
    expect(toExpensePayablesCsv([])).toBe(
      CSV_BOM + `${EXPENSE_PAYABLES_CSV_HEADER.join(',')}\r\n`,
    );
  });
});
