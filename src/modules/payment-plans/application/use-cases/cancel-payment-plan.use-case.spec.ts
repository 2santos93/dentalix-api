import { NotFoundException } from '@nestjs/common';
import { CancelPaymentPlanUseCase } from './cancel-payment-plan.use-case';
import { InMemoryPaymentPlanRepository } from './__fixtures__/in-memory-payment-plan.repository';

const NOW = new Date('2026-03-02T15:00:00.000Z');
const CANCEL = { byId: 'u-recepcion', reason: 'El paciente pagará de contado' };

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
    const useCase = new CancelPaymentPlanUseCase(repo, () => NOW);
    await useCase.execute('tp-1', CANCEL);
    expect(await repo.findActiveByPlan('tp-1')).toBeNull();
  });

  it('DX-092 (SEC-029): guarda quién, cuándo (reloj del servidor) y por qué', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    const created = await seed(repo);
    const useCase = new CancelPaymentPlanUseCase(repo, () => NOW);
    await useCase.execute('tp-1', CANCEL);
    expect(await repo.findCancelledByPlan('tp-1')).toEqual([
      expect.objectContaining({
        id: created.id,
        cancelledAt: NOW,
        cancelledBy: { id: 'u-recepcion', fullName: null },
        cancelReason: 'El paciente pagará de contado',
      }),
    ]);
  });

  it('throws NotFound when there is no active plan', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    const useCase = new CancelPaymentPlanUseCase(repo, () => NOW);
    await expect(useCase.execute('tp-1', CANCEL)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
