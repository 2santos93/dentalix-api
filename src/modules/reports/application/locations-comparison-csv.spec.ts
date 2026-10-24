import {
  EMPTY_AGGREGATES,
  KPI_DEFINITIONS,
  KPI_KEYS,
} from '../domain/kpi-definitions';
import {
  LOCATIONS_COMPARISON_CSV_HEADER,
  toLocationsComparisonCsv,
} from './locations-comparison-csv';
import {
  GetLocationsComparisonUseCase,
  type LocationsComparison,
} from './use-cases/get-locations-comparison.use-case';

async function report(name: string): Promise<LocationsComparison> {
  const useCase = new GetLocationsComparisonUseCase({
    listLocations: () =>
      Promise.resolve([
        { id: 'l1', name, isActive: true, timeZone: 'America/Bogota' },
      ]),
    aggregate: (period) =>
      Promise.resolve({
        byLocation: new Map([
          [
            'l1',
            period.from === '2026-10-01'
              ? {
                  ...EMPTY_AGGREGATES,
                  production: new Map([['COP', 12]]),
                  collected: new Map([['EUR', 7.5]]),
                  completed: 9,
                  noShow: 1,
                  attendedPatients: 3,
                }
              : {
                  ...EMPTY_AGGREGATES,
                  production: new Map([['COP', 10]]),
                  completed: 8,
                  noShow: 2,
                  attendedPatients: 2,
                },
          ],
        ]),
        attendedPatients: 3,
      }),
  });
  return useCase.execute({
    from: '2026-10-01',
    to: '2026-10-31',
    compare: 'previous',
    allowedLocationIds: 'ALL',
  });
}

function lines(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n');
}

describe('CSV de «Comparar sedes» (DX-014)', () => {
  it('UTF-8 con BOM, CRLF y la cabecera fija', async () => {
    const csv = toLocationsComparisonCsv(await report('Sede principal'));
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines(csv)[0]).toBe(LOCATIONS_COMPARISON_CSV_HEADER.join(','));
  });

  it('una línea por sede, indicador y moneda, y luego las del total', async () => {
    const rows = lines(
      toLocationsComparisonCsv(await report('Sede principal')),
    );
    const production = rows.filter((l) => l.includes('"Producción"'));
    expect(production).toEqual([
      '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Sede principal","Producción",COP,12.00,10.00,20.0,%,Mejora',
      '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Sede principal","Producción",EUR,0.00,0.00,,,Igual',
      '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Total clínica","Producción",COP,12.00,10.00,20.0,%,Mejora',
      '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Total clínica","Producción",EUR,0.00,0.00,,,Igual',
    ]);
    const noShow = rows.find((l) =>
      l.startsWith(
        '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Sede principal","No-show %"',
      ),
    );
    expect(noShow).toBe(
      '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Sede principal","No-show %",,10.00,20.00,-10.0,p.p.,Mejora',
    );
    // Sin horario: ocupación vacía, sin variación ni evolución.
    expect(rows.find((l) => l.includes('"Sede principal","Ocupación %"'))).toBe(
      '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Sede principal","Ocupación %",,,,,,',
    );
    // 2 sedes (la sede + el total) × (4 por moneda × 2 monedas + 4 sin moneda).
    expect(rows).toHaveLength(1 + 2 * (4 * 2 + 4));
    expect(
      KPI_KEYS.every((k) =>
        rows.some((l) => l.includes(`"${KPI_DEFINITIONS[k].label}"`)),
      ),
    ).toBe(true);
  });

  it('la variación de los porcentajes va en puntos (p.p.) y la del resto en %', async () => {
    const rows = lines(
      toLocationsComparisonCsv(await report('Sede principal')),
    );
    expect(LOCATIONS_COMPARISON_CSV_HEADER).toContain('Variación');
    expect(LOCATIONS_COMPARISON_CSV_HEADER).toContain('Unidad de la variación');
    expect(
      rows.find((l) => l.includes('"Sede principal","Citas atendidas"')),
    ).toBe(
      '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Sede principal","Citas atendidas",,9,8,12.5,%,Mejora',
    );
  });

  it('protege los nombres contra fórmulas en la hoja de cálculo', async () => {
    const csv = toLocationsComparisonCsv(await report('=HYPERLINK("x")'));
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const tab = toLocationsComparisonCsv(await report('\tSede'));
    expect(tab).toContain(`"'\tSede"`);
  });

  it('sin comparación, las columnas del período anterior quedan vacías', async () => {
    const base = await report('Sede principal');
    const csv = toLocationsComparisonCsv({
      ...base,
      compare: 'none',
      previousFrom: null,
      previousTo: null,
    });
    expect(lines(csv)[1].startsWith('2026-10-01 a 2026-10-31,,')).toBe(true);
  });
});
