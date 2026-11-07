import { CSV_BOM } from '../../../shared/csv/csv-cells';
import { toCents } from '../../../shared/money/money';
import type { ExpenseView } from './expense-view';
import { EXPENSES_CSV_HEADER, toExpensesCsv } from './expenses-csv';

const row: ExpenseView = {
  id: 'e1',
  locationId: 'l1',
  category: '=Categoría propia',
  supplier: '+cmd|calc "x"',
  description: 'Línea 1\nLínea 2',
  amount: 150000,
  currency: 'RSD',
  invoiceDate: '2026-10-01',
  dueDate: '2026-10-10',
  paidAmount: 50000,
  pendingAmount: 100000,
  status: 'PARTIAL',
  overdue: true,
  attachment: null,
  createdById: 'u1',
  createdByName: null,
  createdAt: new Date('2026-10-01T15:00:00Z'),
  updatedAt: new Date('2026-10-01T15:00:00Z'),
  voidedAt: null,
  voidedById: null,
  voidedByName: null,
  voidReason: null,
};
const names = new Map([['l1', '@Sede Norte']]);

describe('CSV de gastos (DX-274)', () => {
  it('UTF-8 con BOM, CRLF, cabecera y una línea por gasto', () => {
    const csv = toExpensesCsv([row], names);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(EXPENSES_CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
  });

  it('protege las fórmulas, escapa comillas y aplana saltos de línea', () => {
    const line = toExpensesCsv([row], names).slice(1).split('\r\n')[1];
    expect(line).toBe(
      [
        '2026-10-01',
        '2026-10-10',
        `"'@Sede Norte"`,
        `"'=Categoría propia"`,
        `"'+cmd|calc ""x"""`,
        '"Línea 1 Línea 2"',
        'RSD',
        '150000',
        '50000',
        '100000',
        'Parcial',
        'Sí',
      ].join(','),
    );
  });

  it('importes con los decimales de cada moneda', () => {
    const eur = {
      ...row,
      currency: 'EUR',
      amount: 12.5,
      paidAmount: 0,
      pendingAmount: 12.5,
      status: 'PENDING' as const,
      overdue: false,
      dueDate: null,
    };
    const line = toExpensesCsv([eur], names).slice(1).split('\r\n')[1];
    expect(line.split(',').slice(-6)).toEqual([
      'EUR',
      '12.50',
      '0.00',
      '12.50',
      'Pendiente',
      'No',
    ]);
    expect(line.split(',')[1]).toBe('');
  });

  it('sin gastos, solo la cabecera', () => {
    expect(toExpensesCsv([], names)).toBe(
      CSV_BOM + EXPENSES_CSV_HEADER.join(',') + '\r\n',
    );
  });

  it('DX-488: un gasto de 150000.50 en una moneda de redondeo 0 sale con sus céntimos, e importe = pagado + pendiente', () => {
    const rsd = {
      ...row,
      amount: 150000.5,
      paidAmount: 0.45,
      pendingAmount: 150000.05,
    };
    const cells = toExpensesCsv([rsd], names)
      .slice(1)
      .split('\r\n')[1]
      .split(',');
    const [amount, paid, pending] = cells.slice(-5, -2);
    expect([cells.at(-6), amount, paid, pending]).toEqual([
      'RSD',
      '150000.50',
      '0.45',
      '150000.05',
    ]);
    expect(toCents(Number(paid)) + toCents(Number(pending))).toBe(
      toCents(Number(amount)),
    );
  });

  it('DX-488: JPY entero sin decimales y JPY con céntimos guardados con 2', () => {
    const jpy = (amount: number, paidAmount: number) => ({
      ...row,
      currency: 'JPY',
      amount,
      paidAmount,
      pendingAmount: (toCents(amount) - toCents(paidAmount)) / 100,
    });
    const lines = toExpensesCsv([jpy(1000, 400), jpy(1000.5, 0.5)], names)
      .slice(1)
      .split('\r\n');
    expect(lines[1].split(',').slice(-6, -2)).toEqual([
      'JPY',
      '1000',
      '400',
      '600',
    ]);
    expect(lines[2].split(',').slice(-6, -2)).toEqual([
      'JPY',
      '1000.50',
      '0.50',
      // Cada celda como en la pantalla: el pendiente entero va sin decimales.
      '1000',
    ]);
  });
});
