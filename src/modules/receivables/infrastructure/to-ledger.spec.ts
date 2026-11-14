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
          ['ob-1', 'VES', 150000.5, '2026-03-15', false, 50000],
          ['ob-2', 'USD', 40, '2026-10-23', true, 0],
        ],
      }),
    });
    expect(withOpenings.openings).toEqual([
      {
        id: 'ob-1',
        currency: 'VES',
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
    // Lo abonado a cada saldo entra como abono suyo (revisión C1).
    expect(withOpenings.paid).toEqual([
      {
        treatmentPlanId: null,
        openingBalanceId: 'ob-1',
        currency: 'VES',
        amount: 50000,
      },
    ]);
    const legacy = toLedger({
      patientId: 'p-1',
      locationId: null,
      ledger: JSON.stringify({ plans: [], paymentPlans: [] }),
    });
    expect(legacy.openings).toEqual([]);
  });

  it('DX-472-bis: lee lo abonado en otra moneda (bases y abonos sin base); una fila anterior no lo trae', () => {
    const plan = (extra: unknown[]) => [
      'tp-1',
      'ACCEPTED',
      'USD',
      0,
      0,
      300,
      50,
      [['VES', 7200]],
      ...extra,
    ];
    const row = toLedger({
      patientId: 'p-1',
      locationId: 'loc-1',
      ledger: JSON.stringify({
        plans: [
          plan([
            100,
            [
              [
                'pay-frozen',
                'VES',
                1800,
                Date.parse('2026-10-14T16:00:00.000Z'),
                'loc-2',
                'USD',
                36,
                1,
                'MANUAL',
                '2026-10-14',
              ],
              [
                'pay-legacy',
                'VES',
                1800,
                Date.parse('2026-10-15T16:00:00.000Z'),
                'loc-2',
                null,
                null,
                null,
                null,
                null,
              ],
            ],
          ]),
        ],
        paymentPlans: [],
      }),
    });
    expect(row.plans[0].otherCurrency).toEqual({
      based: 100,
      pending: [
        {
          id: 'pay-frozen',
          currency: 'VES',
          amount: 1800,
          paidAt: new Date('2026-10-14T16:00:00.000Z'),
          locationId: 'loc-2',
          exchangeRateCurrency: 'USD',
          frozenRate: {
            currency: 'USD',
            fromPerBase: 36,
            toPerBase: 1,
            source: 'MANUAL',
            date: '2026-10-14',
          },
        },
        {
          id: 'pay-legacy',
          currency: 'VES',
          amount: 1800,
          paidAt: new Date('2026-10-15T16:00:00.000Z'),
          locationId: 'loc-2',
          exchangeRateCurrency: null,
          frozenRate: null,
        },
      ],
    });
    // Lo abonado sin convertir sigue en `paid` (para una réplica anterior).
    expect(row.paid).toEqual([
      { treatmentPlanId: 'tp-1', currency: 'USD', amount: 50 },
      { treatmentPlanId: 'tp-1', currency: 'VES', amount: 7200 },
    ]);

    const before = toLedger({
      patientId: 'p-1',
      locationId: 'loc-1',
      ledger: JSON.stringify({ plans: [plan([])], paymentPlans: [] }),
    });
    expect(before.plans[0].otherCurrency).toBeUndefined();
  });
});
