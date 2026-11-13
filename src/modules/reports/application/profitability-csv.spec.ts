import {
  buildProfitabilityRows,
  PROFITABILITY_DEFINITIONS,
} from '../domain/profitability';
import {
  PROFITABILITY_CSV_HEADER,
  toProfitabilityCsv,
} from './profitability-csv';
import type { ProfitabilityReport } from './use-cases/get-profitability.use-case';

function report(): ProfitabilityReport {
  const locations = [
    {
      id: 'l1',
      name: '=Sede Chacao',
      isActive: true,
      timeZone: 'America/Caracas',
    },
    {
      id: 'l2',
      name: 'Sede Valencia',
      isActive: true,
      timeZone: 'America/Caracas',
    },
  ];
  const rows = buildProfitabilityRows(
    locations,
    [{ locationId: 'l1', currency: 'USD', cents: 150_000, count: 12 }],
    [
      {
        locationId: 'l1',
        currency: 'USD',
        category: 'Laboratorio',
        cents: 40_000,
        count: 2,
      },
      {
        locationId: 'l1',
        currency: 'VES',
        category: 'Alquiler',
        cents: 1_000_000,
        count: 1,
      },
    ],
  );
  return {
    from: '2026-10-01',
    to: '2026-10-31',
    basis: 'CASH',
    definition: PROFITABILITY_DEFINITIONS.CASH,
    locationId: null,
    restrictedToLocations: false,
    hasActivity: true,
    ...rows,
  };
}

describe('CSV de rentabilidad por sede (DX-410)', () => {
  const csv = toProfitabilityCsv(report());
  const lines = csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n');

  it('UTF-8 con BOM, CRLF y la cabecera', () => {
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines[0]).toBe(PROFITABILITY_CSV_HEADER.join(','));
  });

  it('por sede y moneda: ingresos, categorías, total de gastos, resultado y margen, con la base', () => {
    const p = '"2026-10-01 a 2026-10-31","Caja"';
    expect(lines.slice(1, 11)).toEqual([
      `${p},"'=Sede Chacao","USD","Cobrado","",1500.00,12`,
      `${p},"'=Sede Chacao","USD","Gastos pagados","Laboratorio",400.00,2`,
      `${p},"'=Sede Chacao","USD","Total gastos","",400.00,2`,
      `${p},"'=Sede Chacao","USD","Resultado","",1100.00,`,
      `${p},"'=Sede Chacao","USD","Margen (%)","",73.3,`,
      `${p},"'=Sede Chacao","VES","Cobrado","",0.00,0`,
      `${p},"'=Sede Chacao","VES","Gastos pagados","Alquiler",10000.00,1`,
      `${p},"'=Sede Chacao","VES","Total gastos","",10000.00,1`,
      `${p},"'=Sede Chacao","VES","Resultado","",-10000.00,`,
      `${p},"'=Sede Chacao","VES","Margen (%)","",,`,
    ]);
  });

  it('una sede sin movimientos sale en una línea, y el total del grupo al final', () => {
    expect(lines[11]).toBe(
      '"2026-10-01 a 2026-10-31","Caja","Sede Valencia","","Sin movimientos","",,',
    );
    expect(lines.slice(12).every((l) => l.includes('"Total del grupo"'))).toBe(
      true,
    );
    expect(lines).toHaveLength(1 + 10 + 1 + 10);
  });

  it('en devengo escribe la otra base y sus conceptos', () => {
    const accrual = toProfitabilityCsv({
      ...report(),
      basis: 'ACCRUAL',
      definition: PROFITABILITY_DEFINITIONS.ACCRUAL,
    });
    expect(accrual).toContain(
      '"Devengo","\'=Sede Chacao","USD","Producción realizada"',
    );
    expect(accrual).toContain('"Gastos facturados","Laboratorio"');
  });
});
