import { ListPaymentsUseCase } from './list-payments.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';

describe('ListPaymentsUseCase', () => {
  it('lists only active payments for the given plan, DESC by paidAt', async () => {
    const repo = new InMemoryPaymentRepository();
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

    const uc = new ListPaymentsUseCase(repo);
    const result = await uc.execute('plan-1');

    expect(result.map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('returns an empty list for a plan with no payments', async () => {
    const repo = new InMemoryPaymentRepository();
    const uc = new ListPaymentsUseCase(repo);

    const result = await uc.execute('no-such-plan');

    expect(result).toEqual([]);
  });
});
