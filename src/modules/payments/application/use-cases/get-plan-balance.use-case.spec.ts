import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import { GetPlanBalanceUseCase } from './get-plan-balance.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import { TreatmentPlanDetail } from '../../../treatment-plans/domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../../treatment-plans/domain/entities/treatment-plan-item.entity';

class FakeGetTreatmentPlanUseCase {
  public plan: TreatmentPlanDetail | null = null;

  execute(): Promise<TreatmentPlanDetail> {
    if (!this.plan) {
      return Promise.reject(new NotFoundException('Treatment plan not found'));
    }
    return Promise.resolve(this.plan);
  }
}

interface FakeConvertInput {
  amount: number;
  from: string;
  to: string;
  date: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Deterministic fake for `ConvertAmountUseCase`: fixed rate per source
 * currency (1 USD = 4000 COP by default), same-currency passthrough.
 * Records every call so specs can assert per-payment-date conversion --
 * mirrors sales/get-sales-totals.use-case.spec.ts's
 * FakeConvertAmountUseCase.
 *
 * IMP-4a regression: the REAL `ConvertAmountUseCase.rateUsed` is
 * amount-dependent -- `rateUsed = round2(amount * rate) / amount` -- because
 * it's derived from the ALREADY-ROUNDED result of THAT specific amount, not
 * a fixed exchange rate. A fake that returns a constant `rateUsed` can never
 * expose a bug where the use case reuses one payment's `rateUsed` for a
 * different payment's amount, so this fake reproduces the real per-amount
 * rounding behavior instead.
 */
class FakeConvertAmountUseCase {
  public readonly calls: FakeConvertInput[] = [];
  /** Currencies (as `from`) that should make `execute` reject with the same
   * `BadRequestException` shape `ConvertAmountUseCase` throws for an
   * unsupported currency (IMP-4b). */
  public readonly failingFrom = new Set<string>();
  /** Currencies (as `from`) that should make `execute` reject with a
   * generic, non-currency error -- simulates an infra/DB failure that must
   * PROPAGATE rather than be swallowed as a skipped payment. */
  public readonly infraFailingFrom = new Set<string>();
  /** units of `from` currency per 1 USD-equivalent `to`; mirrors
   * `rates[from]` in the real use case. */
  private readonly unitsPerTarget: Record<string, number> = { COP: 4000 };

  /** Test helper: register a fixed rate for a currency pair (units of
   * `from` per 1 unit of `to`), used by the mixed-amount regression test. */
  setRate(from: string, unitsPerTo: number): void {
    this.unitsPerTarget[from] = unitsPerTo;
  }

  execute(input: FakeConvertInput): Promise<{
    amount: number;
    from: string;
    to: string;
    date: string;
    result: number;
    rateUsed: number;
  }> {
    this.calls.push(input);
    if (this.infraFailingFrom.has(input.from)) {
      return Promise.reject(
        new Error(`simulated infra failure converting ${input.from}`),
      );
    }
    if (this.failingFrom.has(input.from)) {
      return Promise.reject(
        new BadRequestException(`unsupported currency: ${input.from}`),
      );
    }
    if (input.from === input.to) {
      return Promise.resolve({ ...input, result: input.amount, rateUsed: 1 });
    }
    const unitsPerTo = this.unitsPerTarget[input.from];
    if (unitsPerTo === undefined) {
      throw new Error(
        `unsupported conversion in fake: ${input.from}->${input.to}`,
      );
    }
    const result = round2(input.amount / unitsPerTo);
    const rateUsed = input.amount !== 0 ? result / input.amount : 1 / unitsPerTo;
    return Promise.resolve({ ...input, result, rateUsed });
  }
}

function makeItem(
  overrides: Partial<TreatmentPlanItem> = {},
): TreatmentPlanItem {
  return {
    id: 'item-1',
    tenantId: 't1',
    planId: 'plan-1',
    toothNumber: '11',
    surfaces: [],
    catalogItemId: 'cat-1',
    price: 100,
    status: TreatmentPlanItemStatus.PROPOSED,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makePlan(
  overrides: Partial<TreatmentPlanDetail> = {},
): TreatmentPlanDetail {
  return {
    id: 'plan-1',
    tenantId: 't1',
    patientId: 'patient-1',
    status: TreatmentPlanStatus.DRAFT,
    currency: 'USD',
    notes: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    items: [],
    total: 0,
    ...overrides,
  };
}

describe('GetPlanBalanceUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryPaymentRepository();
    const fakeGetPlan = new FakeGetTreatmentPlanUseCase();
    const fakeConvert = new FakeConvertAmountUseCase();
    const uc = new GetPlanBalanceUseCase(
      repo,
      fakeGetPlan as unknown as GetTreatmentPlanUseCase,
      fakeConvert as unknown as ConvertAmountUseCase,
    );
    return { repo, fakeGetPlan, fakeConvert, uc };
  }

  it('billable counts ONLY ACCEPTED and DONE items, never PROPOSED', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({
          id: 'i1',
          price: 100,
          status: TreatmentPlanItemStatus.PROPOSED,
        }),
        makeItem({
          id: 'i2',
          price: 200,
          status: TreatmentPlanItemStatus.ACCEPTED,
        }),
        makeItem({
          id: 'i3',
          price: 300,
          status: TreatmentPlanItemStatus.DONE,
        }),
      ],
    });

    const result = await uc.execute('plan-1');

    expect(result.billable).toBe(500);
    expect(result.planCurrency).toBe('USD');
  });

  it("paid = Σ payments converted to plan currency by each payment's own paidAt date", async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({ price: 1000, status: TreatmentPlanItemStatus.ACCEPTED }),
      ],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 400000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T12:00:00.000Z'),
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 30,
      currency: 'USD',
      paidAt: new Date('2026-03-10T08:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    // 400000 COP / 4000 = 100 USD, plus 30 USD passthrough = 130.
    expect(result.paid).toBe(130);
    expect(result.billable).toBe(1000);
    expect(result.balance).toBe(870);
    expect(result.paymentsCount).toBe(2);
    // `listByPlan` orders DESC by paidAt (see PaymentRepository contract),
    // so the 03-10 payment is converted before the 03-05 one.
    expect(fakeConvert.calls).toEqual([
      { amount: 30, from: 'USD', to: 'USD', date: '2026-03-10' },
      { amount: 400000, from: 'COP', to: 'USD', date: '2026-03-05' },
    ]);
  });

  it('excludes a voided payment from paid/balance', async () => {
    const { repo, fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [makeItem({ price: 500, status: TreatmentPlanItemStatus.DONE })],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 200,
      currency: 'USD',
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 999,
      currency: 'USD',
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    expect(result.paid).toBe(200);
    expect(result.balance).toBe(300);
    expect(result.paymentsCount).toBe(1);
  });

  it('returns billable=0, paid=0, balance=0 for a plan with no items and no payments', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    const result = await uc.execute('plan-1');

    expect(result).toEqual({
      planCurrency: 'USD',
      billable: 0,
      paid: 0,
      balance: 0,
      paymentsCount: 0,
    });
  });

  it('propagates NotFoundException when the plan is absent', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = null;

    await expect(uc.execute('missing-plan')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // IMP-4a follow-up: each payment is converted FRESH (own amount, own
  // paidAt date) -- NOT memoized/reused from another payment sharing the
  // same date+currency.
  it('converts each payment independently, even when several share the same date and currency', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({ price: 1000, status: TreatmentPlanItemStatus.ACCEPTED }),
      ],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 400000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T09:00:00.000Z'),
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 200000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T18:00:00.000Z'),
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 40000,
      currency: 'COP',
      paidAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    // 400000/4000 + 200000/4000 + 40000/4000 = 100 + 50 + 10 = 160.
    expect(result.paid).toBe(160);
    expect(result.paymentsCount).toBe(3);
    // One convertAmount.execute() call PER PAYMENT -- no memoization/reuse
    // across payments sharing a date+currency.
    expect(fakeConvert.calls).toHaveLength(3);
  });

  // IMP-4a regression: memoizing `rateUsed` per (date, currency) and
  // reapplying it via `round2(amount * cachedRateUsed)` reproduces the
  // FIRST-PROCESSED payment's rounding for every other payment sharing that
  // pair, drifting the total whenever amounts don't divide evenly by the
  // rate. With amounts [1, 2, 5, 7, 100, 333] at a fixed 3-units-per-USD
  // rate, fresh-per-payment conversion sums 0.33+0.67+1.67+2.33+33.33+111 =
  // 149.33, while memoizing the first-processed payment's (amount=1)
  // rateUsed=0.33 against the rest sums to 147.84. This test asserts the
  // correct (fresh-per-payment) total and FAILS under the memoized
  // implementation. `listByPlan` orders DESC by paidAt (see the other
  // tests above), so the amount=1 payment is given the LATEST paidAt to
  // make it the first one processed.
  it('sums independently-rounded conversions for mixed amounts sharing a date/currency (no rate memoization drift)', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeConvert.setRate('AAA', 3);
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({ price: 1000, status: TreatmentPlanItemStatus.ACCEPTED }),
      ],
    });
    const amounts = [1, 2, 5, 7, 100, 333];
    amounts.forEach((amount, i) => {
      repo.seedPayment({
        treatmentPlanId: 'plan-1',
        amount,
        currency: 'AAA',
        paidAt: new Date(
          `2026-03-05T${String(amounts.length - 1 - i).padStart(2, '0')}:00:00.000Z`,
        ),
      });
    });

    const result = await uc.execute('plan-1');

    const expectedPaid = round2(
      amounts.reduce((sum, amount) => sum + round2(amount / 3), 0),
    );
    expect(expectedPaid).toBe(149.33);
    expect(result.paid).toBe(149.33);
    expect(result.paid).toBe(expectedPaid);
    expect(fakeConvert.calls).toHaveLength(amounts.length);
  });

  // IMP-4b: one payment with an unsupported currency must not throw and
  // fail the whole balance computation -- it should be skipped instead.
  it('skips a payment whose currency conversion fails, keeping the rest of paid/balance', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeConvert.failingFrom.add('ZZZ');
    fakeGetPlan.plan = makePlan({
      items: [makeItem({ price: 500, status: TreatmentPlanItemStatus.DONE })],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 100,
      currency: 'USD',
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 999,
      currency: 'ZZZ',
      paidAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    expect(result.paid).toBe(100);
    expect(result.balance).toBe(400);
    // `paymentsCount` is unaffected by conversion failures -- it reflects
    // how many active payments exist, not how many could be converted.
    expect(result.paymentsCount).toBe(2);
  });

  // IMP-4b narrowed catch: only the specific "unsupported currency"
  // BadRequestException from ConvertAmountUseCase is safe to skip. ANY
  // OTHER error (e.g. an infra/DB failure inside GetRatesForDateUseCase)
  // must PROPAGATE -- silently swallowing it would corrupt `paid`/`balance`
  // with no trace that anything went wrong.
  it('propagates a non-currency conversion error instead of silently skipping the payment', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeConvert.infraFailingFrom.add('COP');
    fakeGetPlan.plan = makePlan({
      items: [makeItem({ price: 500, status: TreatmentPlanItemStatus.DONE })],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 400000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    await expect(uc.execute('plan-1')).rejects.toThrow(
      'simulated infra failure converting COP',
    );
  });
});
