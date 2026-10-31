import {
  PRODUCTION_CSV_COLUMNS,
  toProductionByProcedureCsv,
} from './production-by-procedure-csv';
import { buildProcedureProduction } from '../domain/production-by-procedure';
import type { ProductionByProcedure } from './use-cases/get-production-by-procedure.use-case';

function report(
  overrides: Partial<ProductionByProcedure> = {},
): ProductionByProcedure {
  const production = buildProcedureProduction([
    {
      catalogItemId: 'c1',
      code: 'D2391',
      label: 'Resina',
      category: 'Operatoria',
      currency: 'COP',
      count: 3,
      gross: 280,
      discounts: 20,
      catalogCount: 3,
      catalogSum: 300,
      catalogPricedNet: 260,
    },
    {
      catalogItemId: 'c1',
      code: 'D2391',
      label: 'Resina',
      category: 'Operatoria',
      currency: 'USD',
      count: 1,
      gross: 50,
      discounts: 0,
      catalogCount: 0,
      catalogSum: 0,
      catalogPricedNet: 0,
    },
    {
      catalogItemId: 'c2',
      code: '=HYPERLINK("x")',
      label: '+Blanqueamiento',
      category: null,
      currency: 'COP',
      count: 1,
      gross: 100,
      discounts: 0,
      catalogCount: 1,
      catalogSum: 80,
      catalogPricedNet: 100,
    },
  ]);
  return {
    from: '2026-10-01',
    to: '2026-10-31',
    scope: 'CLINIC',
    filters: {
      locationId: null,
      locationName: null,
      professionalId: null,
      professionalName: null,
      category: null,
    },
    options: { locations: [], professionals: [], categories: [] },
    ...production,
    unattributed: [
      { currency: 'COP', count: 2, gross: 150, discounts: 10, net: 140 },
    ],
    hasActivity: true,
    ...overrides,
  };
}

function lines(csv: string): string[] {
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv.endsWith('\r\n')).toBe(true);
  return csv.slice(1, -2).split('\r\n');
}

describe('toProductionByProcedureCsv (DX-423)', () => {
  it('cabecera con período y filtros; después las mismas filas, subtotales, totales y «Sin atribuir» que la pantalla', () => {
    expect(lines(toProductionByProcedureCsv(report()))).toEqual([
      '"Producción por procedimiento"',
      '"Período","2026-10-01 a 2026-10-31"',
      '"Sede","Todas tus sedes"',
      '"Profesional","Todo el equipo"',
      '"Categoría","Todas"',
      '"Importes","Por moneda, sin convertir"',
      '',
      PRODUCTION_CSV_COLUMNS.map((c) => `"${c}"`).join(','),
      '"Procedimiento","Operatoria","D2391","Resina",COP,3,280.00,20.00,260.00,86.67,100.00,-13.3',
      '"Procedimiento","Operatoria","D2391","Resina",USD,1,50.00,0.00,50.00,50.00,,',
      '"Subtotal","Operatoria","","",COP,3,280.00,20.00,260.00,86.67,,',
      '"Subtotal","Operatoria","","",USD,1,50.00,0.00,50.00,50.00,,',
      `"Procedimiento","Sin categoría","'=HYPERLINK(""x"")","'+Blanqueamiento",COP,1,100.00,0.00,100.00,100.00,80.00,25.0`,
      '"Subtotal","Sin categoría","","",COP,1,100.00,0.00,100.00,100.00,,',
      '"Total","","","",COP,4,380.00,20.00,360.00,90.00,,',
      '"Total","","","",USD,1,50.00,0.00,50.00,50.00,,',
      '"Sin atribuir","","","",COP,2,150.00,10.00,140.00,,,',
    ]);
  });

  it('con filtros: la sede, el profesional y la categoría por nombre', () => {
    const csv = toProductionByProcedureCsv(
      report({
        scope: 'OWN',
        filters: {
          locationId: 'l1',
          locationName: 'Sede Norte',
          professionalId: 'u1',
          professionalName: 'Dra. Ana',
          category: 'Operatoria',
        },
      }),
    );
    expect(lines(csv).slice(2, 5)).toEqual([
      '"Sede","Sede Norte"',
      '"Profesional","Solo tu producción (Dra. Ana)"',
      '"Categoría","Operatoria"',
    ]);
  });

  it('sin actividad: cabecera y columnas, sin filas', () => {
    const csv = toProductionByProcedureCsv(
      report({
        rows: [],
        categoryTotals: [],
        totals: [],
        unattributed: [],
        hasActivity: false,
      }),
    );
    expect(lines(csv)).toHaveLength(8);
  });
});
