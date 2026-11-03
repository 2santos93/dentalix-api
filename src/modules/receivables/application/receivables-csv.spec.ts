import { emptyBuckets } from '../domain/aging';
import type { AgingCsvRow } from './use-cases/get-receivables-aging.use-case';
import { RECEIVABLES_CSV_HEADER, toReceivablesCsv } from './receivables-csv';

function row(overrides: Partial<AgingCsvRow> = {}): AgingCsvRow {
  return {
    patient: {
      id: 'p1',
      fullName: 'Ana Pérez',
      phone: '+58 412 123 4567',
      whatsApp: '584121234567',
    },
    locationId: 'loc-1',
    oldestAgeDays: 120,
    ageApproximate: true,
    paymentsWithoutRateCount: 0,
    rateProviderTimedOut: false,
    currencies: [
      {
        currency: 'VES',
        balance: 750000,
        debt: 800000,
        credit: 50000,
        buckets: { ...emptyBuckets(), days0to30: 300000, over90: 500000 },
        oldestAgeDays: 120,
        ageApproximate: true,
        nextInstallment: {
          dueDate: new Date('2026-11-07T00:00:00.000Z'),
          amount: 100000,
        },
        paymentsWithoutRateCount: 0,
        rateProviderTimedOut: false,
      },
    ],
    lastPayment: { paidOn: '2026-09-30', amount: 50000, currency: 'VES' },
    nextInstallment: null,
    lastNote: null,
    lastNoteOn: null,
    promise: null,
    ...overrides,
  };
}

describe('toReceivablesCsv', () => {
  it('una línea por paciente y moneda, con BOM, CRLF y la marca de fecha aproximada', () => {
    const csv = toReceivablesCsv([row()]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(RECEIVABLES_CSV_HEADER.join(','));
    expect(lines[1]).toBe(
      [
        '"Ana Pérez"',
        // Empieza por «+»: se neutraliza para que la hoja no lo lea como fórmula.
        `"'+58 412 123 4567"`,
        'VES',
        '800000.00',
        '0.00',
        '300000.00',
        '0.00',
        '0.00',
        '500000.00',
        '50000.00',
        '750000.00',
        '120',
        'Sí',
        '2026-09-30',
        '50000.00',
        'VES',
        '2026-11-07',
        '100000.00',
        '',
        '',
        '',
        '',
        '',
        '',
        // DX-472-ter: cifras completas, celda vacía.
        '',
      ].join(','),
    );
    expect(lines[2]).toBe('');
  });

  it('dice «No» cuando la antigüedad es cierta y deja vacío lo que no hay', () => {
    const csv = toReceivablesCsv([
      row({
        patient: { id: 'p2', fullName: 'Luis', phone: null, whatsApp: null },
        lastPayment: null,
        currencies: [
          {
            currency: 'USD',
            balance: 10,
            debt: 10,
            credit: 0,
            buckets: { ...emptyBuckets(), current: 10 },
            oldestAgeDays: null,
            ageApproximate: false,
            nextInstallment: null,
            paymentsWithoutRateCount: 0,
            rateProviderTimedOut: false,
          },
        ],
      }),
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      '"Luis","",USD,10.00,10.00,0.00,0.00,0.00,0.00,0.00,10.00,,No,,,,,,,,,,,,',
    );
  });

  it('DX-150: lleva la última gestión (canal · resultado y día de la sede) y el último compromiso, sin el texto de la nota', () => {
    const csv = toReceivablesCsv([
      row({
        lastNote: {
          channel: 'CALL',
          outcome: 'PROMISED_PAYMENT',
          createdAt: new Date('2026-10-16T02:00:00.000Z'),
        },
        lastNoteOn: '2026-10-15',
        promise: {
          id: 'pp1',
          amount: 200000,
          currency: 'VES',
          dueDate: '2026-11-15',
          status: 'BROKEN',
          reopenedAt: null,
        },
      }),
    ]);
    const header = csv.slice(1).split('\r\n')[0].split(',');
    expect(header.slice(-7, -1)).toEqual([
      'Última gestión',
      'Fecha última gestión',
      'Compromiso',
      'Importe compromiso',
      'Moneda compromiso',
      'Fecha compromiso',
    ]);
    expect(csv.split('\r\n')[1]).toMatch(
      /,"Llamada · Promete pago",2026-10-15,"Incumplido",200000\.00,VES,2026-11-15,$/,
    );
  });

  it('DX-472-ter: «Cifras incompletas» es la última columna y dice por qué en cada línea (vacía si está completa)', () => {
    const line = (flags: {
      paymentsWithoutRateCount: number;
      rateProviderTimedOut: boolean;
    }) => {
      const base = row();
      const csv = toReceivablesCsv([
        row({ currencies: [{ ...base.currencies[0], ...flags }] }),
      ]);
      return csv.split('\r\n')[1].split(',').at(-1);
    };
    expect(RECEIVABLES_CSV_HEADER.at(-1)).toBe('Cifras incompletas');
    // Las 24 columnas de antes no se mueven (importaciones existentes).
    expect(RECEIVABLES_CSV_HEADER.indexOf('Fecha compromiso')).toBe(23);
    expect(
      line({ paymentsWithoutRateCount: 0, rateProviderTimedOut: false }),
    ).toBe('');
    expect(
      line({ paymentsWithoutRateCount: 2, rateProviderTimedOut: false }),
    ).toBe('"Sin tasa"');
    // Sin respuesta del proveedor: esos abonos también cuentan como sin tasa,
    // pero lo que hay que hacer es volver a exportar.
    expect(
      line({ paymentsWithoutRateCount: 1, rateProviderTimedOut: true }),
    ).toBe('"Proveedor sin respuesta"');
  });

  it('DX-472-ter: cada moneda dice lo suyo; el aviso de un plan en EUR no marca la línea en USD', () => {
    const base = row().currencies[0];
    const csv = toReceivablesCsv([
      row({
        paymentsWithoutRateCount: 1,
        currencies: [
          { ...base, currency: 'EUR', paymentsWithoutRateCount: 1 },
          { ...base, currency: 'USD' },
        ],
      }),
    ]);
    const [eur, usd] = csv.split('\r\n').slice(1, 3);
    expect(eur).toMatch(/^"Ana Pérez",[^,]*,EUR,.*,"Sin tasa"$/);
    expect(usd).toMatch(/^"Ana Pérez",[^,]*,USD,.*,$/);
  });

  it('escapa comillas y neutraliza fórmulas en el nombre (=, +, -, @)', () => {
    const csv = toReceivablesCsv([
      row({
        patient: {
          id: 'p3',
          fullName: '=HYPERLINK("x") "Ana"',
          phone: '@1',
          whatsApp: null,
        },
      }),
    ]);
    expect(csv.split('\r\n')[1]).toMatch(
      /^"'=HYPERLINK\(""x""\) ""Ana""","'@1",/,
    );
  });

  it('sin filas, solo la cabecera', () => {
    expect(toReceivablesCsv([])).toBe(
      `\uFEFF${RECEIVABLES_CSV_HEADER.join(',')}\r\n`,
    );
  });
});
