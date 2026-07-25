import { NotFoundException } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { ListPaymentsUseCase } from './list-payments.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { TreatmentPlanDetail } from '../../../treatment-plans/domain/entities/treatment-plan.entity';

/**
 * Fake for `GetTreatmentPlanUseCase` -- same pattern as
 * record-payment.use-case.spec.ts / get-plan-balance.use-case.spec.ts: a
 * concrete class (not an interface port), cast via
 * `as unknown as GetTreatmentPlanUseCase` at the injection site.
 */
class FakeGetTreatmentPlanUseCase {
  public plan: TreatmentPlanDetail | null = null;

  execute(): Promise<TreatmentPlanDetail> {
    if (!this.plan) {
      return Promise.reject(new NotFoundException('Treatment plan not found'));
    }
    return Promise.resolve(this.plan);
  }
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

describe('ListPaymentsUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryPaymentRepository();
    const fakeGetPlan = new FakeGetTreatmentPlanUseCase();
    const uc = new ListPaymentsUseCase(
      repo,
      fakeGetPlan as unknown as GetTreatmentPlanUseCase,
    );
    return { repo, fakeGetPlan, uc };
  }

  it('lists only active payments for the given plan, DESC by paidAt', async () => {
    const { repo, fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({ id: 'plan-1' });
    repo.seedPayment({
      id: 'p1',
      treatmentPlanId: 'plan-1',
      amount: 100,
      paidAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p2',
      treatmentPlanId: 'plan-1',
      amount: 50,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p3',
      treatmentPlanId: 'plan-2',
      amount: 999,
    });
    repo.seedPayment({
      id: 'p4',
      treatmentPlanId: 'plan-1',
      amount: 10,
      deletedAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    expect(result.map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('returns an empty list for an existing plan with no payments', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({ id: 'plan-1' });

    const result = await uc.execute('plan-1');

    expect(result).toEqual([]);
  });

  // 404 parity with GET .../balance (GetPlanBalanceUseCase): a nonexistent
  // or cross-tenant plan id must reject with NotFoundException, not
  // silently return `200 []`.
  it('propagates NotFoundException when the plan is absent', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = null;

    await expect(uc.execute('no-such-plan')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
