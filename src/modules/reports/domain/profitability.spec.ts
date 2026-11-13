import {
  buildProfitabilityRows,
  expensePaymentStatus,
  GROUP_TOTAL_NAME,
  marginPercent,
  PROFITABILITY_DEFINITIONS,
  type ProfitabilityLocation,
} from './profitability';

const chacao: ProfitabilityLocation = {
  id: 'loc-chacao',
  name: 'Sede Chacao',
  isActive: true,
  timeZone: 'America/Caracas',
};
const valencia: ProfitabilityLocation = {
  id: 'loc-valencia',
  name: 'Sede Valencia',
  isActive: false,
  timeZone: 'America/Caracas',
};

describe('Rentabilidad por sede: la fórmula (DX-410)', () => {
  it('resultado = ingresos − gastos por sede y moneda, con los gastos por categoría', () => {
    const { locations } = buildProfitabilityRows(
      [chacao],
      [{ locationId: chacao.id, currency: 'USD', cents: 150_000, count: 12 }],
      [
        {
          locationId: chacao.id,
          currency: 'USD',
          category: 'Laboratorio',
          cents: 40_000,
          count: 2,
        },
        {
          locationId: chacao.id,
          currency: 'USD',
          category: 'Insumos clínicos',
          cents: 20_000,
          count: 5,
        },
      ],
    );
    expect(locations[0]).toEqual({
      locationId: chacao.id,
      name: 'Sede Chacao',
      isActive: true,
      timeZone: 'America/Caracas',
      currencies: [
        {
          currency: 'USD',
          income: 1500,
          incomeCount: 12,
          expenses: 600,
          expenseCount: 7,
          net: 900,
          margin: 60,
          categories: [
            { category: 'Laboratorio', amount: 400, count: 2 },
            { category: 'Insumos clínicos', amount: 200, count: 5 },
          ],
        },
      ],
    });
  });

  it('nunca mezcla monedas: un gasto en VES no se resta de un ingreso en USD', () => {
    const { locations, total } = buildProfitabilityRows(
      [chacao],
      [{ locationId: chacao.id, currency: 'USD', cents: 10_000, count: 1 }],
      [
        {
          locationId: chacao.id,
          currency: 'VES',
          category: 'Alquiler',
          cents: 500_000,
          count: 1,
        },
      ],
    );
    const byCurrency = (rows: (typeof locations)[0]['currencies']) =>
      rows.map((c) => [c.currency, c.income, c.expenses, c.net, c.margin]);
    expect(byCurrency(locations[0].currencies)).toEqual([
      ['USD', 100, 0, 100, 100],
      ['VES', 0, 5000, -5000, null],
    ]);
    expect(byCurrency(total.currencies)).toEqual(
      byCurrency(locations[0].currencies),
    );
  });

  it('el total del grupo suma las sedes moneda a moneda, en céntimos exactos', () => {
    const { total } = buildProfitabilityRows(
      [chacao, valencia],
      [
        { locationId: chacao.id, currency: 'USD', cents: 10, count: 1 },
        { locationId: valencia.id, currency: 'USD', cents: 20, count: 1 },
      ],
      [
        {
          locationId: chacao.id,
          currency: 'USD',
          category: 'Laboratorio',
          cents: 5,
          count: 1,
        },
        {
          locationId: valencia.id,
          currency: 'USD',
          category: 'Laboratorio',
          cents: 7,
          count: 1,
        },
        {
          locationId: valencia.id,
          currency: 'USD',
          category: 'Papelería',
          cents: 1,
          count: 1,
        },
      ],
    );
    expect(total).toMatchObject({
      locationId: null,
      name: GROUP_TOTAL_NAME,
      timeZone: null,
    });
    expect(total.currencies).toEqual([
      {
        currency: 'USD',
        income: 0.3,
        incomeCount: 2,
        expenses: 0.13,
        expenseCount: 3,
        net: 0.17,
        margin: 56.7,
        categories: [
          { category: 'Laboratorio', amount: 0.12, count: 2 },
          { category: 'Papelería', amount: 0.01, count: 1 },
        ],
      },
    ]);
  });

  it('una sede sin movimientos sale con la lista vacía; una suma de una sede ajena no cuenta', () => {
    const { locations, total } = buildProfitabilityRows(
      [chacao, valencia],
      [{ locationId: 'otra', currency: 'USD', cents: 999_00, count: 1 }],
      [
        {
          locationId: 'otra',
          currency: 'USD',
          category: 'Otros',
          cents: 1,
          count: 1,
        },
      ],
    );
    expect(locations.map((l) => [l.name, l.currencies])).toEqual([
      ['Sede Chacao', []],
      ['Sede Valencia', []],
    ]);
    expect(total.currencies).toEqual([]);
  });

  it('ordena monedas alfabéticamente y categorías de mayor a menor (empate por nombre)', () => {
    const { locations } = buildProfitabilityRows(
      [chacao],
      [
        { locationId: chacao.id, currency: 'VES', cents: 1, count: 1 },
        { locationId: chacao.id, currency: 'USD', cents: 1, count: 1 },
      ],
      [
        {
          locationId: chacao.id,
          currency: 'USD',
          category: 'Papelería',
          cents: 100,
          count: 1,
        },
        {
          locationId: chacao.id,
          currency: 'USD',
          category: 'Limpieza y cafetería',
          cents: 100,
          count: 1,
        },
        {
          locationId: chacao.id,
          currency: 'USD',
          category: 'Laboratorio',
          cents: 300,
          count: 1,
        },
      ],
    );
    expect(locations[0].currencies.map((c) => c.currency)).toEqual([
      'USD',
      'VES',
    ]);
    expect(
      locations[0].currencies[0].categories.map((c) => c.category),
    ).toEqual(['Laboratorio', 'Limpieza y cafetería', 'Papelería']);
  });

  it('margen: resultado ÷ ingresos con 1 decimal; sin ingresos, null', () => {
    expect(marginPercent(900, 1500)).toBe(60);
    expect(marginPercent(-500, 1000)).toBe(-50);
    expect(marginPercent(1, 3)).toBe(33.3);
    expect(marginPercent(-100, 0)).toBeNull();
  });

  it('estado de pago de un gasto en devengo', () => {
    expect(expensePaymentStatus(1000, 0)).toBe('UNPAID');
    expect(expensePaymentStatus(1000, 400)).toBe('PARTIAL');
    expect(expensePaymentStatus(1000, 1000)).toBe('PAID');
  });

  it('cada base lleva su nombre y dice qué cuenta y por qué fecha', () => {
    expect(PROFITABILITY_DEFINITIONS.CASH).toMatchObject({
      label: 'Caja',
      incomeLabel: 'Cobrado',
      expensesLabel: 'Gastos pagados',
    });
    expect(PROFITABILITY_DEFINITIONS.ACCRUAL).toMatchObject({
      label: 'Devengo',
      incomeLabel: 'Producción realizada',
      expensesLabel: 'Gastos facturados',
    });
    expect(PROFITABILITY_DEFINITIONS.CASH.formula).toMatch(/fecha de pago/);
    expect(PROFITABILITY_DEFINITIONS.ACCRUAL.formula).toMatch(
      /fecha de factura, pagados o no/,
    );
    for (const def of Object.values(PROFITABILITY_DEFINITIONS)) {
      expect(def.howItIsCalculated.join(' ')).toMatch(/sin convertir/);
      expect(def.howItIsCalculated.join(' ')).toMatch(/una sola vez/);
    }
  });
});
