import { NotFoundException } from '@nestjs/common';
import { GetPaymentPlanUseCase } from './get-payment-plan.use-case';
import { InMemoryPaymentPlanRepository } from './__fixtures__/in-memory-payment-plan.repository';
import { GetPlanBalanceUseCase } from '../../../payments/application/use-cases/get-plan-balance.use-case';

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

function makeUseCase(paid: number, rateProviderTimedOut = false) {
  const repo = new InMemoryPaymentPlanRepository();
  const getPlanBalance = {
    executeWithItems: jest.fn(() =>
      Promise.resolve({
        planCurrency: 'USD',
        billable: 300,
        paid,
        balance: 300 - paid,
        creditMovements: 0,
        paymentsCount: 1,
        paymentsWithoutRate: [],
        rateProviderTimedOut,
      }),
    ),
  } as unknown as GetPlanBalanceUseCase;
  // Inject a fixed clock so "overdue" is deterministic.
  const useCase = new GetPaymentPlanUseCase(repo, getPlanBalance, () => TODAY);
  return { repo, useCase };
}

describe('GetPaymentPlanUseCase', () => {
  it('throws NotFound when there is no active plan', async () => {
    const { useCase } = makeUseCase(0);
    await expect(useCase.execute('tp-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('DX-123 (B-4): find → null (no 404) si el plan de tratamiento existe sin plan de cuotas', async () => {
    const { useCase } = makeUseCase(0);
    await expect(useCase.find('tp-1')).resolves.toBeNull();
  });

  it('DX-123: find → 404 si el plan de tratamiento no existe o es de otra clínica', async () => {
    const { repo, useCase } = makeUseCase(0);
    repo.existingTreatmentPlans = new Set(['tp-otro']);
    await expect(useCase.find('tp-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('DX-123: find devuelve el mismo plan derivado que execute', async () => {
    const { repo, useCase } = makeUseCase(150);
    await seed(repo);
    expect(await useCase.find('tp-1')).toEqual(await useCase.execute('tp-1'));
  });

  it('derives installment statuses from the paid total', async () => {
    const { repo, useCase } = makeUseCase(150);
    await seed(repo);
    const res = await useCase.execute('tp-1');
    // paid 150: inst1 (Jan, due<today) PAID; inst2 (Feb, due<today) covered 50 -> OVERDUE; inst3 (Apr) PENDING
    expect(res.installments.map((i) => i.status)).toEqual([
      'PAID',
      'OVERDUE',
      'PENDING',
    ]);
    expect(res.paidTotal).toBe(150);
    expect(res.remaining).toBe(150);
    expect(res.overdueCount).toBe(1);
    expect(res.overdueAmount).toBe(50);
    expect(res.nextDue).toMatchObject({ sequence: 2, amount: 100 });
  });

  it('expone las cifras de /balance tal cual (DX-472)', async () => {
    const { repo, useCase } = makeUseCase(150);
    await seed(repo);
    const res = await useCase.execute('tp-1');
    expect(res).toMatchObject({
      billable: 300,
      paid: 150,
      creditMovements: 0,
      balance: 150,
      paymentsWithoutRate: [],
      rateProviderTimedOut: false,
    });
  });

  it('con el proveedor colgado ninguna cuota sale vencida por lo no convertido (DX-472)', async () => {
    const { repo, useCase } = makeUseCase(150, true);
    await seed(repo);
    const res = await useCase.execute('tp-1');
    expect(res.installments.map((i) => i.status)).toEqual([
      'PAID',
      'PARTIAL',
      'PENDING',
    ]);
    expect(res.overdueCount).toBe(0);
    expect(res.overdueAmount).toBe(0);
    expect(res.rateProviderTimedOut).toBe(true);
  });

  it('allocates the down payment tramo first', async () => {
    const { repo, useCase } = makeUseCase(250);
    await seed(repo, 200);
    const res = await useCase.execute('tp-1');
    expect(res.downPaymentStatus).toMatchObject({
      amount: 200,
      covered: 200,
      status: 'PAID',
    });
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

  describe('DX-110: vence por el día civil de la sede del plan (Caracas)', () => {
    async function at(now: string) {
      const repo = new InMemoryPaymentPlanRepository();
      repo.timeZone = 'America/Caracas';
      const getPlanBalance = {
        executeWithItems: jest.fn(() =>
          Promise.resolve({
            planCurrency: 'USD',
            billable: 300,
            paid: 0,
            balance: 300,
            creditMovements: 0,
            paymentsCount: 0,
            paymentsWithoutRate: [],
            rateProviderTimedOut: false,
          }),
        ),
      } as unknown as GetPlanBalanceUseCase;
      await repo.create({
        treatmentPlanId: 'tp-1',
        patientId: 'p1',
        currency: 'USD',
        totalToFinance: 300,
        downPayment: 0,
        installmentsCount: 3,
        periodicity: 'MONTHLY',
        startDate: new Date('2026-11-10'),
        installments: [
          { sequence: 1, dueDate: new Date('2026-11-10'), amount: 100 },
          { sequence: 2, dueDate: new Date('2026-12-10'), amount: 100 },
          { sequence: 3, dueDate: new Date('2027-01-10'), amount: 100 },
        ],
      });
      return new GetPaymentPlanUseCase(
        repo,
        getPlanBalance,
        () => new Date(now),
      ).execute('tp-1');
    }

    it('cuota que vence hoy, a las 21:00 de Caracas (01:00Z de mañana) → no vencida', async () => {
      const res = await at('2026-11-11T01:00:00.000Z');
      expect(res.installments[0].status).toBe('PENDING');
      expect(res.overdueCount).toBe(0);
    });

    it('al día siguiente a las 00:30 de Caracas → vencida', async () => {
      const res = await at('2026-11-11T04:30:00.000Z');
      expect(res.installments[0].status).toBe('OVERDUE');
      expect(res.overdueCount).toBe(1);
      expect(res.overdueAmount).toBe(100);
    });
  });
});
