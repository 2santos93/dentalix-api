import { NotFoundException } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { VoidPaymentUseCase } from './void-payment.use-case';
import { ListPaymentsUseCase } from './list-payments.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { TreatmentPlanDetail } from '../../../treatment-plans/domain/entities/treatment-plan.entity';

// Minimal fake for `GetTreatmentPlanUseCase` -- `ListPaymentsUseCase` now
// resolves the plan first (IMP-3, 404 parity with GET .../balance); this
// spec only cares about void/list interaction, so the fake always
// "finds" the plan.
class FakeGetTreatmentPlanUseCase {
  execute(): Promise<TreatmentPlanDetail> {
    return Promise.resolve({
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
    });
  }
}

describe('VoidPaymentUseCase', () => {
  it('soft-deletes an existing payment, excluding it from active listings', async () => {
    const repo = new InMemoryPaymentRepository();
    const payment = repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 100,
    });
    const voidUc = new VoidPaymentUseCase(repo);
    const listUc = new ListPaymentsUseCase(
      repo,
      new FakeGetTreatmentPlanUseCase() as unknown as GetTreatmentPlanUseCase,
    );

    await voidUc.execute(payment.id);

    const remaining = await listUc.execute('plan-1');
    expect(remaining).toEqual([]);
  });

  it('throws NotFoundException when the payment is absent', async () => {
    const repo = new InMemoryPaymentRepository();
    const uc = new VoidPaymentUseCase(repo);

    await expect(uc.execute('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the payment is already voided', async () => {
    const repo = new InMemoryPaymentRepository();
    const payment = repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 100,
    });
    const uc = new VoidPaymentUseCase(repo);

    await uc.execute(payment.id);

    await expect(uc.execute(payment.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
