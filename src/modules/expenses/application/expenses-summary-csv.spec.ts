import {
  EXPENSES_SUMMARY_CSV_HEADER,
  toExpensesSummaryCsv,
} from './expenses-summary-csv';
import type { ExpenseSummaryRowView } from './use-cases/get-expense-summary.use-case';

const ves: ExpenseSummaryRowView = {
  month: '2026-10',
  locationId: 'l1',
  locationName: '=Sede',
  currency: 'RSD',
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
    const csv = toExpensesSummaryCsv([ves]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      EXPENSES_SUMMARY_CSV_HEADER.join(','),
      `2026-10,"'=Sede",RSD,Ingresos,"",500000`,
      `2026-10,"'=Sede",RSD,Gasto,"Arriendo",300000`,
      `2026-10,"'=Sede",RSD,Gasto,"'-Propia",50000`,
      `2026-10,"'=Sede",RSD,Total gastos,"",350000`,
      `2026-10,"'=Sede",RSD,Neto,"",150000`,
      '',
    ]);
  });

  it('decimales por moneda y neto negativo', () => {
    const usd: ExpenseSummaryRowView = {
      ...ves,
      locationName: 'Sur',
      currency: 'USD',
      income: 0,
      categories: [{ category: 'Otros', amount: 10.5 }],
      expensesTotal: 10.5,
      net: -10.5,
    };
    const lines = toExpensesSummaryCsv([usd]).slice(1).split('\r\n');
    expect(lines[1].endsWith(',0.00')).toBe(true);
    expect(lines[4]).toBe('2026-10,"Sur",USD,Neto,"",-10.50');
  });

  it('DX-488: céntimos guardados en una moneda de redondeo 0 no se pierden (RSD 150000.50)', () => {
    const lines = toExpensesSummaryCsv([
      {
        ...ves,
        income: 150000.5,
        categories: [{ category: 'Arriendo', amount: 0.45 }],
        expensesTotal: 0.45,
        net: 150000.05,
      },
    ])
      .slice(1)
      .split('\r\n');
    expect(lines.slice(1, 5).map((l) => l.split(',').at(-1))).toEqual([
      '150000.50',
      '0.45',
      '0.45',
      '150000.05',
    ]);
  });
});
