import { toUnallocatedPaymentsCsv } from './unallocated-payments-csv';
import type { UnallocatedPayments } from './use-cases/get-unallocated-payments.use-case';

const report = (
  over: Partial<UnallocatedPayments> = {},
): UnallocatedPayments => ({
  from: '2026-10-01',
  to: '2026-10-31',
  filters: { locationId: null, locationName: null },
  options: { locations: [] },
  items: [
    {
      paymentId: 'p1',
      patient: { id: 'a', fullName: '=HYPERLINK("x")' },
      location: { id: 'l', name: 'Sede "Centro"' },
      paidOn: '2026-10-20',
      paymentAmount: 4000,
      paymentCurrency: 'VES',
      planId: 'pl',
      planCurrency: 'USD',
      allocated: 70,
      unallocated: 30.5,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 1,
  totals: [{ currency: 'USD', count: 1, allocated: 70, unallocated: 30.5 }],
  paymentsWithoutRateCount: 0,
  ...over,
});

describe('toUnallocatedPaymentsCsv (DX-399)', () => {
  it('writes BOM, CRLF, header, rows with ISO codes and per-currency totals', () => {
    const csv = toUnallocatedPaymentsCsv(report());
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('"Cobrado sin imputar / a cuenta"');
    expect(lines[1]).toBe('"Período","2026-10-01 a 2026-10-31"');
    expect(lines[2]).toBe('"Sede","Todas tus sedes"');
    expect(lines[5]).toBe(
      '"Fila","Paciente","Sede","Fecha del abono","Moneda del abono","Importe del abono","Moneda del plan","Imputado","Sin imputar"',
    );
    expect(lines[6]).toBe(
      '"Abono","\'=HYPERLINK(""x"")","Sede ""Centro""","2026-10-20","VES",4000.00,"USD",70.00,30.50',
    );
    expect(lines[7]).toBe('"Total","1 abono","","","",,"USD",70.00,30.50');
  });

  it('names the sede filter and leaves only header+columns when empty', () => {
    const csv = toUnallocatedPaymentsCsv(
      report({
        items: [],
        totals: [],
        filters: { locationId: 'l', locationName: 'Sede Norte' },
      }),
    );
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(6);
    expect(lines[2]).toBe('"Sede","Sede Norte"');
  });
});
