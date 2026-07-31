import { InMemoryPaymentPlanRepository } from './in-memory-payment-plan.repository';

function makeInput() {
  return {
    treatmentPlanId: 'plan-1',
    patientId: 'p1',
    currency: 'USD',
    totalToFinance: 300,
    downPayment: 0,
    installmentsCount: 3,
    periodicity: 'MONTHLY' as const,
    startDate: new Date('2026-01-15'),
    installments: [
      { sequence: 1, dueDate: new Date('2026-01-15'), amount: 100 },
      { sequence: 2, dueDate: new Date('2026-02-15'), amount: 100 },
      { sequence: 3, dueDate: new Date('2026-03-15'), amount: 100 },
    ],
  };
}

describe('InMemoryPaymentPlanRepository', () => {
  it('creates a plan and finds it as the active one', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    const created = await repo.create(makeInput());
    expect(created.installments).toHaveLength(3);
    const active = await repo.findActiveByPlan('plan-1');
    expect(active?.id).toBe(created.id);
  });

  it('cancel makes the plan no longer active and is idempotent', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    const created = await repo.create(makeInput());
    expect(await repo.cancel(created.id)).toBe(true);
    expect(await repo.findActiveByPlan('plan-1')).toBeNull();
    expect(await repo.cancel(created.id)).toBe(false);
  });
});
