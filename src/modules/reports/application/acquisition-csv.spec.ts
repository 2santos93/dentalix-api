import { toAcquisitionCsv } from './acquisition-csv';
import type { AcquisitionReport } from './use-cases/get-acquisition.use-case';

const report: AcquisitionReport = {
  period: { from: '2026-10-01', to: '2026-10-31' },
  filters: { locationId: 'l1', locationName: 'Sede Caracas' },
  options: { locations: [] },
  rows: [
    {
      sourceId: 'ig',
      name: 'Instagram',
      kind: 'CHANNEL',
      isActive: true,
      newPatients: 3,
      payingPatients: 3,
      collected: [{ currency: 'VES', amount: 100000 }],
    },
    {
      sourceId: 'x',
      name: '=HYPERLINK("x")',
      kind: 'CHANNEL',
      isActive: false,
      newPatients: 1,
      payingPatients: 0,
      collected: [],
    },
    {
      sourceId: null,
      name: 'Sin dato',
      kind: null,
      isActive: null,
      newPatients: 1,
      payingPatients: 1,
      collected: [{ currency: 'USD', amount: 12.5 }],
    },
  ],
  totals: {
    newPatients: 5,
    payingPatients: 4,
    collected: [
      { currency: 'USD', amount: 12.5 },
      { currency: 'VES', amount: 100000 },
    ],
  },
  topReferrers: [
    {
      patientId: 'p',
      fullName: 'Ana Rodríguez',
      patientCode: '1',
      referred: 1,
      collected: [],
    },
  ],
  currencies: ['USD', 'VES'],
  hasActivity: true,
};

describe('toAcquisitionCsv (DX-172)', () => {
  const csv = toAcquisitionCsv(report);
  const lines = csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n');

  it('UTF-8 con BOM y CRLF, cabecera con período y sede', () => {
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lines[1]).toBe('"Período","2026-10-01 a 2026-10-31"');
    expect(lines[2]).toBe('"Sede","Sede Caracas"');
  });

  it('una columna de cobrado por moneda y una fila por fuente más el total', () => {
    expect(lines[5]).toBe(
      '"Fuente","Tipo","Estado","Pacientes nuevos","Con abonos","Cobrado USD","Cobrado VES"',
    );
    expect(lines[6]).toBe('"Instagram","Canal","Activa",3,3,0.00,100000.00');
    expect(lines[8]).toBe('"Sin dato","","",1,1,12.50,0.00');
    expect(lines[9]).toBe('"Total","","",5,4,12.50,100000.00');
  });

  it('protege las celdas contra fórmulas y no lleva datos de pacientes', () => {
    expect(lines[7].startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
    expect(csv).not.toContain('Ana Rodríguez');
  });
});
