import { NotFoundException } from '@nestjs/common';
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

/**
 * Deterministic fake for `ConvertAmountUseCase`: fixed COP<->USD rate (1 USD
 * = 4000 COP), same-currency passthrough. Records every call so specs can
 * assert per-payment-date conversion -- mirrors
 * sales/get-sales-totals.use-case.spec.ts's FakeConvertAmountUseCase.
 */
class FakeConvertAmountUseCase {
  public readonly calls: FakeConvertInput[] = [];

  execute(input: FakeConvertInput): Promise<{
    amount: number;
    from: string;
    to: string;
    date: string;
    result: number;
    rateUsed: number;
  }> {
    this.calls.push(input);
    if (input.from === input.to) {
      return Promise.resolve({ ...input, result: input.amount, rateUsed: 1 });
    }
    if (input.from === 'COP' && input.to === 'USD') {
      const result = Math.round((input.amount / 4000) * 100) / 100;
      return Promise.resolve({ ...input, result, rateUsed: 1 / 4000 });
    }
    throw new Error(
      `unsupported conversion in fake: ${input.from}->${input.to}`,
    );
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
});
