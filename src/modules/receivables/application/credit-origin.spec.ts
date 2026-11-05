import type {
  OriginPayment,
  PlanCreditFacts,
} from '../domain/entities/credit-balances.entity';
import { originOfPlanCredit } from './credit-origin';

const pay = (
  day: string,
  locationId: string,
  planCents: number | null,
): OriginPayment => ({
  paidAt: new Date(`${day}T15:00:00.000Z`),
  locationId,
  planCents,
});
const facts = (over: Partial<PlanCreditFacts> = {}): PlanCreditFacts => ({
  planLocationId: null,
  ownPayments: [],
  transferredPayments: [],
  ...over,
});

describe('originOfPlanCredit (DX-430)', () => {
  it('plan vivo pagado en cuotas: el origen es el abono que supera lo facturable, no el primero', () => {
    const last = pay('2026-10-10', 'sede-b', 20_000);
    const origin = originOfPlanCredit(
      facts({
        ownPayments: [
          pay('2026-01-10', 'sede-a', 50_000),
          pay('2026-05-10', 'sede-a', 50_000),
          last,
        ],
      }),
      100_000,
    );
    expect(origin.payment).toBe(last);
    expect(origin.locationId).toBe('sede-b');
  });

  it('plan cancelado o rechazado (facturable 0): el primer abono', () => {
    const first = pay('2026-02-01', 'sede-a', 10_000);
    const origin = originOfPlanCredit(
      facts({ ownPayments: [first, pay('2026-03-01', 'sede-b', 10_000)] }),
      0,
    );
    expect(origin.payment).toBe(first);
    expect(origin.locationId).toBe('sede-a');
  });

  it('la sede del propio plan manda sobre la del abono', () => {
    const origin = originOfPlanCredit(
      facts({
        planLocationId: 'sede-plan',
        ownPayments: [pay('2026-02-01', 'sede-a', 10_000)],
      }),
      0,
    );
    expect(origin.locationId).toBe('sede-plan');
    expect(origin.payment?.locationId).toBe('sede-a');
  });

  it('un abono en otra moneda sin base no cuenta para cruzar; si nunca cruza, el último abono', () => {
    const last = pay('2026-03-01', 'sede-a', null);
    const origin = originOfPlanCredit(
      facts({ ownPayments: [pay('2026-02-01', 'sede-a', 10_000), last] }),
      100_000,
    );
    expect(origin.payment).toBe(last);
  });

  it('sin abonos propios (traspaso recibido): el abono más antiguo del plan de origen', () => {
    const oldest = pay('2026-01-05', 'sede-a', 30_000);
    const origin = originOfPlanCredit(
      facts({ transferredPayments: [oldest, pay('2026-02-05', 'sede-b', 1)] }),
      0,
    );
    expect(origin.payment).toBe(oldest);
    expect(origin.locationId).toBe('sede-a');
  });

  it('sin nada: sin sede ni fecha', () => {
    expect(originOfPlanCredit(facts(), 0)).toEqual({
      locationId: null,
      payment: null,
    });
  });
});
