import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreatePaymentPlanUseCase } from './create-payment-plan.use-case';
import { InMemoryPaymentPlanRepository } from './__fixtures__/in-memory-payment-plan.repository';

function makeDeps(
  overrides: {
    planCurrency?: string;
    balance?: number;
    planThrows?: boolean;
  } = {},
) {
  const repo = new InMemoryPaymentPlanRepository();
  const getTreatmentPlan = {
    execute: jest.fn(async (id: string) => {
      if (overrides.planThrows) {
        throw new NotFoundException('Treatment plan not found');
      }
      return {
        id,
        patientId: 'p1',
        currency: overrides.planCurrency ?? 'USD',
        items: [],
        total: 0,
      };
    }),
  } as any;
  const getPlanBalance = {
    execute: jest.fn(async () => ({
      planCurrency: overrides.planCurrency ?? 'USD',
      billable: overrides.balance ?? 1200,
      paid: 0,
      balance: overrides.balance ?? 1200,
      paymentsCount: 0,
    })),
  } as any;
  const useCase = new CreatePaymentPlanUseCase(
    repo,
    getTreatmentPlan,
    getPlanBalance,
  );
  return { repo, getTreatmentPlan, getPlanBalance, useCase };
}

const baseInput = {
  downPayment: 0,
  installmentsCount: 12,
  periodicity: 'MONTHLY' as const,
  startDate: '2026-01-15T00:00:00.000Z',
};

describe('CreatePaymentPlanUseCase', () => {
  it('defaults totalToFinance to the current plan balance and generates N installments', async () => {
    const { useCase } = makeDeps({ balance: 1200 });
    const plan = await useCase.execute('tp-1', baseInput, 'u1');
    expect(plan.totalToFinance).toBe(1200);
    expect(plan.currency).toBe('USD');
    expect(plan.patientId).toBe('p1');
    expect(plan.installments).toHaveLength(12);
    expect(plan.installments.every((i) => i.amount === 100)).toBe(true);
  });

  it('honors an explicit totalToFinance', async () => {
    const { useCase } = makeDeps({ balance: 1200 });
    const plan = await useCase.execute(
      'tp-1',
      { ...baseInput, totalToFinance: 600, installmentsCount: 6 },
      'u1',
    );
    expect(plan.totalToFinance).toBe(600);
    expect(plan.installments.every((i) => i.amount === 100)).toBe(true);
  });

  it('rejects a second ACTIVE plan for the same treatment plan (409)', async () => {
    const { useCase } = makeDeps();
    await useCase.execute('tp-1', baseInput, 'u1');
    await expect(
      useCase.execute('tp-1', baseInput, 'u1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects installmentsCount < 1', async () => {
    const { useCase } = makeDeps();
    await expect(
      useCase.execute('tp-1', { ...baseInput, installmentsCount: 0 }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects downPayment greater than totalToFinance', async () => {
    const { useCase } = makeDeps({ balance: 500 });
    await expect(
      useCase.execute('tp-1', { ...baseInput, downPayment: 600 }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-positive resolved totalToFinance', async () => {
    const { useCase } = makeDeps({ balance: 0 });
    await expect(
      useCase.execute('tp-1', baseInput, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid startDate', async () => {
    const { useCase } = makeDeps();
    await expect(
      useCase.execute('tp-1', { ...baseInput, startDate: 'not-a-date' }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('propagates NotFound when the treatment plan is absent', async () => {
    const { useCase } = makeDeps({ planThrows: true });
    await expect(useCase.execute('missing', baseInput, 'u1')).rejects.toThrow(
      'Treatment plan not found',
    );
  });

  it('defaults totalToFinance to the plan billable (gross), not the net balance', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    const getTreatmentPlan = {
      execute: jest.fn(async (id: string) => ({
        id,
        patientId: 'p1',
        currency: 'USD',
        items: [],
        total: 0,
      })),
    } as any;
    const getPlanBalance = {
      execute: jest.fn(async () => ({
        planCurrency: 'USD',
        billable: 1200,
        paid: 200,
        balance: 1000,
        paymentsCount: 1,
      })),
    } as any;
    const useCase = new CreatePaymentPlanUseCase(
      repo,
      getTreatmentPlan,
      getPlanBalance,
    );
    const plan = await useCase.execute(
      'tp-1',
      {
        downPayment: 0,
        installmentsCount: 12,
        periodicity: 'MONTHLY',
        startDate: '2026-01-15T00:00:00.000Z',
      },
      'u1',
    );
    expect(plan.totalToFinance).toBe(1200); // gross billable, NOT the 1000 net balance
  });

  it('rejects installmentsCount > 600', async () => {
    const { useCase } = makeDeps();
    await expect(
      useCase.execute('tp-1', { ...baseInput, installmentsCount: 601 }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a concurrent-insert P2002 unique violation to the same 409 as the check-then-act path', async () => {
    const repo = new InMemoryPaymentPlanRepository();
    jest.spyOn(repo, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    const getTreatmentPlan = {
      execute: jest.fn(async (id: string) => ({
        id,
        patientId: 'p1',
        currency: 'USD',
        items: [],
        total: 0,
      })),
    } as any;
    const getPlanBalance = {
      execute: jest.fn(async () => ({
        planCurrency: 'USD',
        billable: 1200,
        paid: 0,
        balance: 1200,
        paymentsCount: 0,
      })),
    } as any;
    const useCase = new CreatePaymentPlanUseCase(
      repo,
      getTreatmentPlan,
      getPlanBalance,
    );
    await expect(
      useCase.execute('tp-1', baseInput, 'u1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
