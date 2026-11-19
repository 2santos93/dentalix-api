import { toReceivablesSummaryCsv } from './receivables-csv';

describe('CSV de los totales de la cartera (DX-304)', () => {
  const buckets = {
    current: 10,
    days0to30: 20,
    days31to60: 30,
    days61to90: 0,
    over90: 40.5,
  };

  it('una línea por moneda, sin pacientes, nunca sumadas entre monedas', () => {
    const csv = toReceivablesSummaryCsv({
      asOf: '2026-11-19',
      locationName: '=Sede',
      totals: [
        {
          currency: 'USD',
          patients: 3,
          balance: 95.5,
          debt: 100.5,
          credit: 5,
          buckets,
        },
        {
          currency: 'VES',
          patients: 1,
          balance: 3650,
          debt: 3650,
          credit: 0,
          buckets: {
            ...buckets,
            current: 3650,
            days0to30: 0,
            days31to60: 0,
            over90: 0,
          },
        },
      ],
      paymentsWithoutRateCount: 0,
      rateProviderTimedOut: false,
    });
    const lines = csv.split('\r\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines).toContain(`"Sede","'=Sede"`);
    expect(lines).toContain(
      '"USD",3,100.50,10.00,20.00,30.00,0.00,40.50,5.00,95.50',
    );
    expect(lines).toContain(
      '"VES",1,3650.00,3650.00,0.00,0.00,0.00,0.00,0.00,3650.00',
    );
    expect(lines.filter((l) => /^"(USD|VES)"/.test(l))).toHaveLength(2);
  });

  it('avisa de los abonos sin tasa', () => {
    const csv = toReceivablesSummaryCsv({
      asOf: '2026-11-19',
      locationName: null,
      totals: [],
      paymentsWithoutRateCount: 2,
      rateProviderTimedOut: false,
    });
    expect(csv).toContain('"Aviso","2 abonos en otra moneda aún no cuentan');
    expect(csv).toContain('"Sede","Todas tus sedes"');
  });
});
