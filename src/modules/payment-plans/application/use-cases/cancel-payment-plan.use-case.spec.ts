import { NotFoundException } from '@nestjs/common';
import { CancelPaymentPlanUseCase } from './cancel-payment-plan.use-case';
import { InMemoryPaymentPlanRepository } from './__fixtures__/in-memory-payment-plan.repository';

function seed(repo: InMemoryPaymentPlanRepository) {
  return repo.create({
    treatmentPlanId: 'tp-1',
    patientId: 'p1',
    currency: 'USD',
    totalToFinance: 100,
    downPayment: 0,
    installmentsCount: 1,
    periodicity: 'MONTHLY',
    startDate: new Date('2026-01-15'),
    installments: [
      { sequence: 1, dueDate: new Date('2026-01-15'), amount: 100 },
    ],
  });
}

describe('CancelPaymentPlanUseCase', () => {
  it('cancels the active plan', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    await seed(repo);
    const useCase = new CancelPaymentPlanUseCase(repo);
    await useCase.execute('tp-1');
    expect(await repo.findActiveByPlan('tp-1')).toBeNull();
  });

  it('throws NotFound when there is no active plan', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    const useCase = new CancelPaymentPlanUseCase(repo);
    await expect(useCase.execute('tp-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
