import {
  buildProcedureProduction,
  UNCATEGORIZED_LABEL,
  type ProcedureSums,
} from './production-by-procedure';

function sums(overrides: Partial<ProcedureSums> = {}): ProcedureSums {
  return {
    catalogItemId: 'c-1',
    code: 'D2391',
    label: 'Resina',
    category: 'Operatoria',
    currency: 'VES',
    count: 0,
    gross: 0,
    discounts: 0,
    catalogCount: 0,
    catalogSum: 0,
    catalogPricedNet: 0,
    ...overrides,
  };
}

describe('buildProcedureProduction (DX-423)', () => {
  it('100, 100 y 80 con 20 de descuento: 3 · bruto 280 · descuentos 20 · neto 260 · medio 86,67 frente a catálogo 100 (−13,3 %)', () => {
    const report = buildProcedureProduction([
      sums({
        count: 3,
        gross: 280,
        discounts: 20,
        catalogCount: 3,
        catalogSum: 300,
        catalogPricedNet: 260,
      }),
    ]);
    expect(report.rows).toEqual([
      {
        catalogItemId: 'c-1',
        code: 'D2391',
        label: 'Resina',
        category: 'Operatoria',
        currency: 'VES',
        count: 3,
        gross: 280,
        discounts: 20,
        net: 260,
        averageNet: 86.67,
        catalogAverage: 100,
        catalogCount: 3,
        differencePercent: -13.3,
      },
    ]);
    expect(report.totals).toEqual([
      {
        currency: 'VES',
        count: 3,
        gross: 280,
        discounts: 20,
        net: 260,
        averageNet: 86.67,
      },
    ]);
  });

  it('sin precio de catálogo congelado (anterior a DX-105): medio de catálogo y diferencia en null', () => {
    const [row] = buildProcedureProduction([
      sums({ count: 2, gross: 200, discounts: 0 }),
    ]).rows;
    expect(row).toMatchObject({
      averageNet: 100,
      catalogAverage: null,
      catalogCount: 0,
      differencePercent: null,
    });
  });

  it('la diferencia compara solo los ítems con catálogo: el neto de esos frente a su catálogo', () => {
    // 2 ítems con catálogo 100 (neto 90 + 110 = 200) y 1 sin catálogo (neto 40).
    const [row] = buildProcedureProduction([
      sums({
        count: 3,
        gross: 240,
        discounts: 0,
        catalogCount: 2,
        catalogSum: 200,
        catalogPricedNet: 200,
      }),
    ]).rows;
    expect(row.averageNet).toBe(80);
    expect(row.catalogAverage).toBe(100);
    expect(row.differencePercent).toBe(0);
  });

  it('catálogo a 0 (cortesía): sin diferencia en %', () => {
    const [row] = buildProcedureProduction([
      sums({
        count: 1,
        gross: 50,
        catalogCount: 1,
        catalogSum: 0,
        catalogPricedNet: 50,
      }),
    ]).rows;
    expect(row.catalogAverage).toBe(0);
    expect(row.differencePercent).toBeNull();
  });

  it('dos monedas: subtotal por moneda y ningún total mezclado', () => {
    const report = buildProcedureProduction([
      sums({ currency: 'VES', count: 2, gross: 200_000, discounts: 10_000 }),
      sums({ currency: 'USD', count: 1, gross: 50, discounts: 0 }),
      sums({
        catalogItemId: 'c-2',
        code: 'D1110',
        label: 'Profilaxis',
        category: 'Prevención',
        currency: 'VES',
        count: 1,
        gross: 80_000,
        discounts: 0,
      }),
    ]);
    expect(report.totals).toEqual([
      {
        currency: 'USD',
        count: 1,
        gross: 50,
        discounts: 0,
        net: 50,
        averageNet: 50,
      },
      {
        currency: 'VES',
        count: 3,
        gross: 280_000,
        discounts: 10_000,
        net: 270_000,
        averageNet: 90_000,
      },
    ]);
    expect(report.categoryTotals).toEqual([
      expect.objectContaining({
        category: 'Operatoria',
        currency: 'USD',
        net: 50,
      }),
      expect.objectContaining({
        category: 'Operatoria',
        currency: 'VES',
        net: 190_000,
      }),
      expect.objectContaining({
        category: 'Prevención',
        currency: 'VES',
        net: 80_000,
      }),
    ]);
  });

  it('ordena por categoría (sin categoría al final), código y moneda', () => {
    const report = buildProcedureProduction([
      sums({
        catalogItemId: 'x',
        code: 'Z9',
        category: null,
        count: 1,
        gross: 1,
      }),
      sums({
        catalogItemId: 'b',
        code: 'B2',
        category: 'Prevención',
        count: 1,
        gross: 1,
      }),
      sums({
        catalogItemId: 'a',
        code: 'A1',
        category: 'Operatoria',
        currency: 'USD',
        count: 1,
        gross: 1,
      }),
      sums({
        catalogItemId: 'a',
        code: 'A1',
        category: 'Operatoria',
        currency: 'VES',
        count: 1,
        gross: 1,
      }),
      sums({
        catalogItemId: 'c',
        code: 'A0',
        category: 'Prevención',
        count: 1,
        gross: 1,
      }),
    ]);
    expect(
      report.rows.map((r) => `${r.category ?? '-'}/${r.code}/${r.currency}`),
    ).toEqual([
      'Operatoria/A1/USD',
      'Operatoria/A1/VES',
      'Prevención/A0/VES',
      'Prevención/B2/VES',
      '-/Z9/VES',
    ]);
    expect(report.categoryTotals.map((c) => c.category)).toEqual([
      'Operatoria',
      'Operatoria',
      'Prevención',
      null,
    ]);
    expect(UNCATEGORIZED_LABEL).toBe('Sin categoría');
  });

  it('sin filas: todo vacío', () => {
    expect(buildProcedureProduction([])).toEqual({
      rows: [],
      categoryTotals: [],
      totals: [],
    });
  });

  it('redondea los importes a 2 decimales al sumar (sin arrastrar error binario)', () => {
    const report = buildProcedureProduction([
      sums({ catalogItemId: 'a', code: 'A', count: 1, gross: 0.1 }),
      sums({ catalogItemId: 'b', code: 'B', count: 1, gross: 0.2 }),
    ]);
    expect(report.totals[0].gross).toBe(0.3);
    expect(report.totals[0].averageNet).toBe(0.15);
  });

  describe('DX-488: honorario medio y medio de catálogo exactos en céntimos', () => {
    it('neto 2.01 en 2 da 1.01 y neto 4.27 en 2 da 2.14 (empates hacia arriba)', () => {
      const report = buildProcedureProduction([
        sums({ catalogItemId: 'a', code: 'A', count: 2, gross: 2.01 }),
        sums({
          catalogItemId: 'b',
          code: 'B',
          count: 2,
          gross: 5,
          discounts: 0.73,
        }),
      ]);
      expect(report.rows.map((r) => [r.code, r.net, r.averageNet])).toEqual([
        ['A', 2.01, 1.01],
        ['B', 4.27, 2.14],
      ]);
      // El total suma los netos exactos (6.28) y su medio es 6.28 ÷ 4 = 1.57.
      expect(report.totals).toEqual([
        expect.objectContaining({
          currency: 'VES',
          count: 4,
          gross: 7.01,
          discounts: 0.73,
          net: 6.28,
          averageNet: 1.57,
        }),
      ]);
    });

    it('medio de catálogo 8.03 ÷ 2 = 4.02 (el épsilon daba 4.01); sin precio de catálogo, null', () => {
      const report = buildProcedureProduction([
        sums({
          catalogItemId: 'a',
          code: 'A',
          count: 2,
          gross: 8,
          catalogCount: 2,
          catalogSum: 8.03,
          catalogPricedNet: 8,
        }),
        sums({ catalogItemId: 'b', code: 'B', count: 1, gross: 10 }),
      ]);
      expect(
        report.rows.map((r) => [r.code, r.catalogAverage, r.catalogCount]),
      ).toEqual([
        ['A', 4.02, 2],
        ['B', null, 0],
      ]);
    });

    it('USD: 4.27 de neto en 2 ítems da 2.14, no 2.13', () => {
      const [row] = buildProcedureProduction([
        sums({ currency: 'USD', count: 2, gross: 4.27 }),
      ]).rows;
      expect(row.averageNet).toBe(2.14);
    });
  });
});
