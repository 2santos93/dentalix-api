import { NotFoundException } from '@nestjs/common';
import { ListCancelledPaymentPlansUseCase } from './list-cancelled-payment-plans.use-case';
import { InMemoryPaymentPlanRepository } from './__fixtures__/in-memory-payment-plan.repository';

function seed(repo: InMemoryPaymentPlanRepository) {
  return repo.create({
    treatmentPlanId: 'tp-1',
    patientId: 'p1',
    currency: 'USD',
    totalToFinance: 600,
    downPayment: 100,
    installmentsCount: 5,
    periodicity: 'MONTHLY',
    startDate: new Date('2026-01-15'),
    installments: [
      { sequence: 1, dueDate: new Date('2026-02-15'), amount: 100 },
    ],
  });
}

describe('ListCancelledPaymentPlansUseCase (DX-123, O-2)', () => {
  it('lista los cancelados del más reciente al más antiguo, sin el activo', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    repo.userNames.set('u-admin', 'Ana Rodríguez');
    const first = await seed(repo);
    await repo.cancel(first.id, {
      byId: 'u-admin',
      at: new Date('2026-02-01T14:00:00Z'),
      reason: 'Cambia a 3 cuotas',
    });
    const second = await seed(repo);
    await repo.cancel(second.id, {
      byId: 'u-admin',
      at: new Date('2026-03-01T14:00:00Z'),
      reason: 'Pagará de contado',
    });
    await seed(repo); // el activo no sale

    const rows = await new ListCancelledPaymentPlansUseCase(repo).execute(
      'tp-1',
    );
    expect(rows.map((r) => [r.id, r.cancelReason])).toEqual([
      [second.id, 'Pagará de contado'],
      [first.id, 'Cambia a 3 cuotas'],
    ]);
    expect(rows[0].cancelledBy).toEqual({
      id: 'u-admin',
      fullName: 'Ana Rodríguez',
    });
  });

  it('lista vacía si nunca se canceló ninguno', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    await expect(
      new ListCancelledPaymentPlansUseCase(repo).execute('tp-1'),
    ).resolves.toEqual([]);
  });

  it('404 si el plan de tratamiento no existe o es de otra clínica', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    repo.existingTreatmentPlans = new Set();
    await expect(
      new ListCancelledPaymentPlansUseCase(repo).execute('tp-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
