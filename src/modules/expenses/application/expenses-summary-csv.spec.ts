import { REFERENCE_CURRENCY_DIGITS } from '../../../shared/money/__fixtures__/reference-currency-digits';
import {
  EXPENSES_SUMMARY_CSV_HEADER,
  toExpensesSummaryCsv,
} from './expenses-summary-csv';
import type { ExpenseSummaryRowView } from './use-cases/get-expense-summary.use-case';

const cop: ExpenseSummaryRowView = {
  month: '2026-10',
  locationId: 'l1',
  locationName: '=Sede',
  currency: 'COP',
  income: 500000,
  categories: [
    { category: 'Arriendo', amount: 300000 },
    { category: '-Propia', amount: 50000 },
  ],
  expensesTotal: 350000,
  net: 150000,
};

describe('CSV del resumen de gastos (DX-274)', () => {
  it('BOM, CRLF y por cada fila: ingresos, categorías, total y neto', () => {
    const csv = toExpensesSummaryCsv([cop], REFERENCE_CURRENCY_DIGITS);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      EXPENSES_SUMMARY_CSV_HEADER.join(','),
      `2026-10,"'=Sede",COP,Ingresos,"",500000`,
      `2026-10,"'=Sede",COP,Gasto,"Arriendo",300000`,
      `2026-10,"'=Sede",COP,Gasto,"'-Propia",50000`,
      `2026-10,"'=Sede",COP,Total gastos,"",350000`,
      `2026-10,"'=Sede",COP,Neto,"",150000`,
      '',
    ]);
  });

  it('decimales por moneda y neto negativo', () => {
    const usd: ExpenseSummaryRowView = {
      ...cop,
      locationName: 'Sur',
      currency: 'USD',
      income: 0,
      categories: [{ category: 'Otros', amount: 10.5 }],
      expensesTotal: 10.5,
      net: -10.5,
    };
    const lines = toExpensesSummaryCsv([usd], REFERENCE_CURRENCY_DIGITS)
      .slice(1)
      .split('\r\n');
    expect(lines[1].endsWith(',0.00')).toBe(true);
    expect(lines[4]).toBe('2026-10,"Sur",USD,Neto,"",-10.50');
  });
});
