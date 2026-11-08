import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, TreatmentPlanStatus } from '@prisma/client';
import { CreatePaymentPlanUseCase } from './create-payment-plan.use-case';
import { InMemoryPaymentPlanRepository } from './__fixtures__/in-memory-payment-plan.repository';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { GetPlanBalanceUseCase } from '../../../payments/application/use-cases/get-plan-balance.use-case';
import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import { CurrencyDigitsTable } from '../../../../shared/money/currency-digits';
import { PLAN_CURRENCY_NOT_IN_CATALOG_MESSAGE } from './create-payment-plan.use-case';
import {
  AMOUNT_NON_NEGATIVE_MESSAGE,
  DOWN_PAYMENT_EXCEEDS_MESSAGE,
  DOWN_PAYMENT_MESSAGE,
  TOTAL_TO_FINANCE_MESSAGE,
  TOTAL_TO_FINANCE_POSITIVE_MESSAGE,
} from '../../../../shared/money/currency-messages';

function makeDeps(
  overrides: {
    planCurrency?: string;
    balance?: number;
    planThrows?: boolean;
    planStatus?: TreatmentPlanStatus;
  } = {},
) {
  const repo = new InMemoryPaymentPlanRepository();
  const getTreatmentPlan = {
    execute: jest.fn((id: string) => {
      if (overrides.planThrows) {
        return Promise.reject(
          new NotFoundException('Treatment plan not found'),
        );
      }
      return Promise.resolve({
        id,
        patientId: 'p1',
        status: overrides.planStatus ?? TreatmentPlanStatus.ACCEPTED,
        currency: overrides.planCurrency ?? 'USD',
        items: [],
        total: 0,
      });
    }),
  } as unknown as GetTreatmentPlanUseCase;
  const getPlanBalance = {
    execute: jest.fn(() =>
      Promise.resolve({
        planCurrency: overrides.planCurrency ?? 'USD',
        billable: overrides.balance ?? 1200,
        paid: 0,
        balance: overrides.balance ?? 1200,
        paymentsCount: 0,
      }),
    ),
  } as unknown as GetPlanBalanceUseCase;
  const useCase = new CreatePaymentPlanUseCase(
    repo,
    getTreatmentPlan,
    getPlanBalance,
    referenceCurrencyDigitsCatalog(),
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
    await expect(
      useCase.execute('tp-1', { ...baseInput, downPayment: 600 }, 'u1'),
    ).rejects.toThrow(DOWN_PAYMENT_EXCEEDS_MESSAGE);
  });

  it('rejects a non-positive resolved totalToFinance', async () => {
    const { useCase } = makeDeps({ balance: 0 });
    await expect(
      useCase.execute('tp-1', baseInput, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(useCase.execute('tp-1', baseInput, 'u1')).rejects.toThrow(
      TOTAL_TO_FINANCE_POSITIVE_MESSAGE,
    );
  });

  // DX-517-quater: los importes inválidos, en español neutro (texto exacto).
  it.each([-1, NaN, Infinity])(
    'downPayment %s: 400 con el texto en español',
    async (downPayment) => {
      const { useCase } = makeDeps({ balance: 500 });
      await expect(
        useCase.execute('tp-1', { ...baseInput, downPayment }, 'u1'),
      ).rejects.toThrow(DOWN_PAYMENT_MESSAGE);
    },
  );

  it.each([-1, NaN, Infinity])(
    'totalToFinance %s: 400 con el texto en español',
    async (totalToFinance) => {
      const { useCase } = makeDeps({ balance: 500 });
      await expect(
        useCase.execute('tp-1', { ...baseInput, totalToFinance }, 'u1'),
      ).rejects.toThrow(TOTAL_TO_FINANCE_MESSAGE);
    },
  );

  it('los textos exactos', () => {
    expect(DOWN_PAYMENT_MESSAGE).toBe(
      'El pago inicial tiene que ser un número mayor o igual que 0.',
    );
    expect(TOTAL_TO_FINANCE_MESSAGE).toBe(
      'El total a financiar tiene que ser un número mayor o igual que 0.',
    );
    expect(TOTAL_TO_FINANCE_POSITIVE_MESSAGE).toBe(
      'El total a financiar tiene que ser mayor que 0.',
    );
    expect(DOWN_PAYMENT_EXCEEDS_MESSAGE).toBe(
      'El pago inicial no puede superar el total a financiar.',
    );
    expect(AMOUNT_NON_NEGATIVE_MESSAGE).toBe(
      'El importe tiene que ser un número mayor o igual que 0.',
    );
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
      execute: jest.fn((id: string) =>
        Promise.resolve({
          id,
          patientId: 'p1',
          currency: 'USD',
          items: [],
          total: 0,
        }),
      ),
    } as unknown as GetTreatmentPlanUseCase;
    const getPlanBalance = {
      execute: jest.fn(() =>
        Promise.resolve({
          planCurrency: 'USD',
          billable: 1200,
          paid: 200,
          balance: 1000,
          paymentsCount: 1,
        }),
      ),
    } as unknown as GetPlanBalanceUseCase;
    const useCase = new CreatePaymentPlanUseCase(
      repo,
      getTreatmentPlan,
      getPlanBalance,
      referenceCurrencyDigitsCatalog(),
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

  it('DX-488: en JPY (0 dígitos de redondeo) reparte en yenes enteros: 10000 en 3 = 3333, 3333, 3334', async () => {
    const { useCase } = makeDeps({ planCurrency: 'JPY', balance: 10000 });
    const plan = await useCase.execute(
      'tp-1',
      { ...baseInput, installmentsCount: 3 },
      'u1',
    );
    expect(plan.installments.map((i) => i.amount)).toEqual([3333, 3333, 3334]);
  });

  it('DX-488: en USD y VES (2 dígitos) sigue al céntimo: 100 en 3 = 33.33, 33.33, 33.34', async () => {
    for (const planCurrency of ['USD', 'VES']) {
      const { useCase } = makeDeps({ planCurrency, balance: 100 });
      const plan = await useCase.execute(
        'tp-1',
        { ...baseInput, installmentsCount: 3 },
        'u1',
      );
      expect(plan.installments.map((i) => i.amount)).toEqual([
        33.33, 33.33, 33.34,
      ]);
    }
  });

  it('DX-488: una moneda del plan que no está en el catálogo es un 422 en español, sin escribir', async () => {
    const { repo, getTreatmentPlan, getPlanBalance } = makeDeps({
      planCurrency: 'VES',
    });
    const useCase = new CreatePaymentPlanUseCase(
      repo,
      getTreatmentPlan,
      getPlanBalance,
      {
        table: () =>
          Promise.resolve(
            new CurrencyDigitsTable([
              { code: 'USD', minorUnits: 2, roundingDigits: 2 },
            ]),
          ),
      },
    );
    const attempt = useCase.execute('tp-1', baseInput, 'u1');
    await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(attempt).rejects.toThrow(
      PLAN_CURRENCY_NOT_IN_CATALOG_MESSAGE('VES'),
    );
    expect(await repo.findActiveByPlan('tp-1')).toBeNull();
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
      execute: jest.fn((id: string) =>
        Promise.resolve({
          id,
          patientId: 'p1',
          currency: 'USD',
          items: [],
          total: 0,
        }),
      ),
    } as unknown as GetTreatmentPlanUseCase;
    const getPlanBalance = {
      execute: jest.fn(() =>
        Promise.resolve({
          planCurrency: 'USD',
          billable: 1200,
          paid: 0,
          balance: 1200,
          paymentsCount: 0,
        }),
      ),
    } as unknown as GetPlanBalanceUseCase;
    const useCase = new CreatePaymentPlanUseCase(
      repo,
      getTreatmentPlan,
      getPlanBalance,
      referenceCurrencyDigitsCatalog(),
    );
    await expect(
      useCase.execute('tp-1', baseInput, 'u1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([TreatmentPlanStatus.REJECTED, TreatmentPlanStatus.CANCELLED])(
    'DX-109: un plan %s no se financia (409 en español, sin escribir)',
    async (planStatus) => {
      const { repo, useCase } = makeDeps({ planStatus });
      const attempt = useCase.execute('tp-1', baseInput, 'u1');
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(
        /no admite abonos ni planes de cuotas/,
      );
      expect(await repo.findActiveByPlan('tp-1')).toBeNull();
    },
  );
});
