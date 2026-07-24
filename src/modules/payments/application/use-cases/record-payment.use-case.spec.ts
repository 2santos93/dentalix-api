import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { RecordPaymentUseCase } from './record-payment.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { TreatmentPlanDetail } from '../../../treatment-plans/domain/entities/treatment-plan.entity';

/**
 * Fake for `GetTreatmentPlanUseCase` -- concrete class (not an interface
 * port), so a plain object literal isn't structurally assignable to it.
 * Cast via `as unknown as GetTreatmentPlanUseCase` at the injection site,
 * same pattern as FakeConvertAmountUseCase in the old
 * sales/get-sales-totals.use-case.spec.ts.
 */
class FakeGetTreatmentPlanUseCase {
  public plan: TreatmentPlanDetail | null = null;
  public readonly calls: string[] = [];

  execute(id: string): Promise<TreatmentPlanDetail> {
    this.calls.push(id);
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

describe('RecordPaymentUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryPaymentRepository();
    const fakeGetPlan = new FakeGetTreatmentPlanUseCase();
    const uc = new RecordPaymentUseCase(
      repo,
      fakeGetPlan as unknown as GetTreatmentPlanUseCase,
    );
    return { repo, fakeGetPlan, uc };
  }

  it('records a payment against an existing plan, deriving patientId from the plan', async () => {
    const { repo, fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({ id: 'plan-1', patientId: 'patient-9' });

    const payment = await uc.execute(
      'plan-1',
      {
        amount: 150,
        currency: 'usd',
        paidAt: '2026-03-05T00:00:00.000Z',
        notes: 'primer abono',
      },
      'user-1',
    );

    expect(payment.treatmentPlanId).toBe('plan-1');
    expect(payment.patientId).toBe('patient-9');
    expect(payment.amount).toBe(150);
    expect(payment.currency).toBe('USD');
    expect(payment.createdById).toBe('user-1');

    const listed = await repo.listByPlan('plan-1');
    expect(listed).toHaveLength(1);
  });

  it('rejects amount <= 0 with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 0,
        currency: 'USD',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      uc.execute('plan-1', {
        amount: -10,
        currency: 'USD',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-finite amount with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: Number.POSITIVE_INFINITY,
        currency: 'USD',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a blank currency with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 10,
        currency: '   ',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid paidAt with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 10,
        currency: 'USD',
        paidAt: 'not-a-date',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('propagates NotFoundException when the plan is absent', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = null;

    await expect(
      uc.execute('missing-plan', {
        amount: 10,
        currency: 'USD',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
