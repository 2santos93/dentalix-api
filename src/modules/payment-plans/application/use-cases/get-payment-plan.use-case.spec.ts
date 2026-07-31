import { NotFoundException } from '@nestjs/common';
import { GetPaymentPlanUseCase } from './get-payment-plan.use-case';
import { InMemoryPaymentPlanRepository } from './__fixtures__/in-memory-payment-plan.repository';

const TODAY = new Date('2026-03-01T00:00:00.000Z');

function seed(repo: InMemoryPaymentPlanRepository, downPayment = 0) {
  return repo.create({
    treatmentPlanId: 'tp-1',
    patientId: 'p1',
    currency: 'USD',
    totalToFinance: 300 + downPayment,
    downPayment,
    installmentsCount: 3,
    periodicity: 'MONTHLY',
    startDate: new Date('2026-01-15'),
    installments: [
      { sequence: 1, dueDate: new Date('2026-01-15'), amount: 100 },
      { sequence: 2, dueDate: new Date('2026-02-15'), amount: 100 },
      { sequence: 3, dueDate: new Date('2026-04-15'), amount: 100 },
    ],
  });
}

function makeUseCase(paid: number) {
  const repo = new InMemoryPaymentPlanRepository();
  const getPlanBalance = {
    execute: jest.fn(async () => ({
      planCurrency: 'USD',
      billable: 300,
      paid,
      balance: 300 - paid,
      paymentsCount: 1,
    })),
  } as any;
  // Inject a fixed clock so "overdue" is deterministic.
  const useCase = new GetPaymentPlanUseCase(repo, getPlanBalance, () => TODAY);
  return { repo, useCase };
}

describe('GetPaymentPlanUseCase', () => {
  it('throws NotFound when there is no active plan', async () => {
    const { useCase } = makeUseCase(0);
    await expect(useCase.execute('tp-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('derives installment statuses from the paid total', async () => {
    const { repo, useCase } = makeUseCase(150);
    await seed(repo);
    const res = await useCase.execute('tp-1');
    // paid 150: inst1 (Jan, due<today) PAID; inst2 (Feb, due<today) covered 50 -> OVERDUE; inst3 (Apr) PENDING
    expect(res.installments.map((i) => i.status)).toEqual(['PAID', 'OVERDUE', 'PENDING']);
    expect(res.paidTotal).toBe(150);
    expect(res.remaining).toBe(150);
    expect(res.overdueCount).toBe(1);
    expect(res.overdueAmount).toBe(50);
    expect(res.nextDue).toMatchObject({ sequence: 2, amount: 100 });
  });

  it('allocates the down payment tramo first', async () => {
    const { repo, useCase } = makeUseCase(250);
    await seed(repo, 200);
    const res = await useCase.execute('tp-1');
    expect(res.downPaymentStatus).toMatchObject({ amount: 200, covered: 200, status: 'PAID' });
    // remaining 50 hits installment 1
    expect(res.installments[0]).toMatchObject({ covered: 50 });
    expect(res.financedAmount).toBe(300);
  });

  it('reports isFullyPaid when paid covers the whole plan', async () => {
    const { repo, useCase } = makeUseCase(300);
    await seed(repo);
    const res = await useCase.execute('tp-1');
    expect(res.isFullyPaid).toBe(true);
    expect(res.remaining).toBe(0);
    expect(res.nextDue).toBeNull();
  });
});
