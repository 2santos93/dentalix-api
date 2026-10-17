import type { PatientAging } from '../../receivables/domain/entities/receivables.entity';
import { emptyBuckets } from '../../receivables/domain/aging';
import { overdueView } from './overdue-balance';

function aging(
  oldestAgeDays: number | null,
  buckets: Partial<ReturnType<typeof emptyBuckets>> = {},
): PatientAging {
  const b = { ...emptyBuckets(), ...buckets };
  const debt = Object.values(b).reduce((s, v) => s + v, 0);
  return {
    oldestAgeDays,
    ageApproximate: false,
    currencies: [
      {
        currency: 'COP',
        balance: debt,
        debt,
        credit: 0,
        buckets: b,
        oldestAgeDays,
        ageApproximate: false,
        nextInstallment: null,
      },
    ],
  };
}

describe('overdueView (DX-150)', () => {
  it('sin deuda: sin marca', () => {
    expect(overdueView(undefined, true)).toEqual({
      hasOverdue: false,
      overdueDays: null,
    });
  });

  it('solo cuotas por vencer: sin marca', () => {
    expect(overdueView(aging(null, { current: 50_000 }), true)).toEqual({
      hasOverdue: false,
      overdueDays: null,
    });
  });

  it('exigible desde hoy (0 días): aún no es saldo vencido', () => {
    expect(overdueView(aging(0, { days0to30: 10_000 }), true).hasOverdue).toBe(
      false,
    );
  });

  it('ADMIN/RECEPTION: marca, días e importe vencido sin lo que está por vencer', () => {
    expect(
      overdueView(
        aging(75, { days0to30: 100_000, days61to90: 50_000, current: 30_000 }),
        true,
      ),
    ).toEqual({
      hasOverdue: true,
      overdueDays: 75,
      amounts: [{ currency: 'COP', amount: 150_000 }],
    });
  });

  it('DENTIST/ASSISTANT: solo la marca y los días, sin importes', () => {
    const view = overdueView(aging(12, { days0to30: 100_000 }), false);
    expect(view).toEqual({ hasOverdue: true, overdueDays: 12 });
    expect(view).not.toHaveProperty('amounts');
  });
});
