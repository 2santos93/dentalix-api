import { NotFoundException } from '@nestjs/common';
import { VoidPaymentUseCase } from './void-payment.use-case';
import { ListPaymentsUseCase } from './list-payments.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';

describe('VoidPaymentUseCase', () => {
  it('soft-deletes an existing payment, excluding it from active listings', async () => {
    const repo = new InMemoryPaymentRepository();
    const payment = repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 100,
    });
    const voidUc = new VoidPaymentUseCase(repo);
    const listUc = new ListPaymentsUseCase(repo);

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
