import { toLedger } from './prisma-receivables.repository';

describe('toLedger (DX-155, DX-262)', () => {
  it('lee los saldos migrados del resumen; una fila anterior sin «openings» no trae ninguno', () => {
    const withOpenings = toLedger({
      patientId: 'p-1',
      locationId: 'loc-1',
      ledger: JSON.stringify({
        plans: [],
        paymentPlans: [],
        openings: [
          ['ob-1', 'COP', 150000.5, '2026-03-15', false],
          ['ob-2', 'USD', 40, '2026-10-23', true],
        ],
      }),
    });
    expect(withOpenings.openings).toEqual([
      {
        id: 'ob-1',
        currency: 'COP',
        amount: 150000.5,
        asOfDate: '2026-03-15',
        asOfDateApproximate: false,
      },
      {
        id: 'ob-2',
        currency: 'USD',
        amount: 40,
        asOfDate: '2026-10-23',
        asOfDateApproximate: true,
      },
    ]);
    const legacy = toLedger({
      patientId: 'p-1',
      locationId: null,
      ledger: JSON.stringify({ plans: [], paymentPlans: [] }),
    });
    expect(legacy.openings).toEqual([]);
  });
});
