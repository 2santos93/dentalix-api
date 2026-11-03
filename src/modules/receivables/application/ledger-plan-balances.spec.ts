import type { PatientLedger } from '../domain/entities/receivables.entity';
import { ledgerPlanBalanceInputs } from './ledger-plan-balances';

const zoneOf = (locationId: string | null) =>
  locationId === 'loc-tokio' ? 'Asia/Tokyo' : 'America/Caracas';

function ledger(overrides: Partial<PatientLedger> = {}): PatientLedger {
  return {
    patientId: 'pat-1',
    locationId: 'loc-1',
    plans: [],
    paid: [],
    paymentPlans: [],
    ...overrides,
  };
}

describe('ledgerPlanBalanceInputs (DX-472-bis)', () => {
  it('solo los planes con abonos en otra moneda, con lo ya sumado en su moneda y los pendientes con su día civil', () => {
    const inputs = ledgerPlanBalanceInputs(
      [
        ledger({
          plans: [
            {
              id: 'tp-usd',
              status: 'ACCEPTED',
              currency: 'USD',
              createdAt: new Date('2026-01-01T12:00:00.000Z'),
              billable: 300,
              agingFrom: new Date('2026-01-01T12:00:00.000Z'),
              otherCurrency: {
                based: 100.1,
                pending: [
                  {
                    id: 'pay-legacy',
                    currency: 'VES',
                    amount: 3600,
                    // 02:00 UTC: aún el día 14 en Caracas, ya el 15 en Tokio.
                    paidAt: new Date('2026-10-15T02:00:00.000Z'),
                    locationId: 'loc-caracas',
                    exchangeRateCurrency: null,
                    frozenRate: null,
                  },
                  {
                    id: 'pay-tokio',
                    currency: 'JPY',
                    amount: 1500,
                    paidAt: new Date('2026-10-15T02:00:00.000Z'),
                    locationId: 'loc-tokio',
                    exchangeRateCurrency: 'USD',
                    frozenRate: null,
                  },
                ],
              },
            },
            {
              id: 'tp-solo-usd',
              status: 'ACCEPTED',
              currency: 'USD',
              createdAt: new Date('2026-01-01T12:00:00.000Z'),
              billable: 50,
              agingFrom: new Date('2026-01-01T12:00:00.000Z'),
            },
          ],
          paid: [
            // Abonos y saldo a favor en su moneda (el resumen ya los suma).
            { treatmentPlanId: 'tp-usd', currency: 'USD', amount: 20.2 },
            { treatmentPlanId: 'tp-usd', currency: 'VES', amount: 9999 },
            { treatmentPlanId: 'tp-solo-usd', currency: 'USD', amount: 50 },
          ],
        }),
      ],
      zoneOf,
    );

    expect(inputs).toEqual([
      {
        plan: { id: 'tp-usd', status: 'ACCEPTED', currency: 'USD' },
        items: [],
        billable: 300,
        paidKnown: 120.3,
        payments: [
          {
            id: 'pay-legacy',
            amount: 3600,
            currency: 'VES',
            paidOn: '2026-10-14',
            exchangeRateCurrency: null,
            frozenRate: null,
          },
          {
            id: 'pay-tokio',
            amount: 1500,
            currency: 'JPY',
            paidOn: '2026-10-15',
            exchangeRateCurrency: 'USD',
            frozenRate: null,
          },
        ],
        baseOf: new Map(),
        creditMovements: 0,
      },
    ]);
  });
});
