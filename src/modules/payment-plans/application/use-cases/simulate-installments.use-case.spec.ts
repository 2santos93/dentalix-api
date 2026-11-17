import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import { SimulateInstallmentsUseCase } from './simulate-installments.use-case';
import { CreatePaymentPlanUseCase } from './create-payment-plan.use-case';
import { InMemoryPaymentPlanRepository } from './__fixtures__/in-memory-payment-plan.repository';
import type { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import type { GetPlanBalanceUseCase } from '../../../payments/application/use-cases/get-plan-balance.use-case';
import { billableTotal } from '../../../payments/application/plan-balance-calculator';
import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import type {
  CurrencyDigitsCatalog,
  CurrencyDigitsTable,
} from '../../../../shared/money/currency-digits';
import { toCents } from '../../../../shared/money/money';

type Item = {
  status: TreatmentPlanItemStatus;
  price: number;
  discount: number;
};

const { PROPOSED, ACCEPTED, DONE } = TreatmentPlanItemStatus;

/**
 * Un plan de tratamiento en memoria: `accept()` hace lo que la aceptación
 * (plan ACCEPTED y propuestos a aceptados). El saldo por defecto del alta
 * sale de la MISMA cuenta que la API (`billableTotal`).
 */
function makePlan(
  items: Item[],
  {
    currency = 'USD',
    status = TreatmentPlanStatus.PRESENTED,
    digits = referenceCurrencyDigitsCatalog(),
  }: {
    currency?: string;
    status?: TreatmentPlanStatus;
    digits?: CurrencyDigitsCatalog;
  } = {},
) {
  const state = { status, items: items.map((i) => ({ ...i })) };
  const getTreatmentPlan = {
    execute: jest.fn((id: string) =>
      Promise.resolve({
        id,
        patientId: 'pat-1',
        status: state.status,
        currency,
        items: state.items,
        total: 0,
      }),
    ),
  } as unknown as GetTreatmentPlanUseCase;
  const getPlanBalance = {
    execute: jest.fn(() => {
      const billable = billableTotal(state.items);
      return Promise.resolve({
        planCurrency: currency,
        billable,
        paid: 0,
        balance: billable,
        paymentsCount: 0,
      });
    }),
  } as unknown as GetPlanBalanceUseCase;
  const repo = new InMemoryPaymentPlanRepository();
  const create = jest.spyOn(repo, 'create');
  const simulate = new SimulateInstallmentsUseCase(
    getTreatmentPlan,
    repo,
    digits,
  );
  const createPlan = new CreatePaymentPlanUseCase(
    repo,
    getTreatmentPlan,
    getPlanBalance,
    digits,
  );
  return {
    simulate,
    createPlan,
    repo,
    create,
    accept: () => {
      state.status = TreatmentPlanStatus.ACCEPTED;
      state.items = state.items.map((i) =>
        i.status === PROPOSED ? { ...i, status: ACCEPTED } : i,
      );
    },
  };
}

const scenario = (
  over: Partial<{
    downPayment: number;
    installmentsCount: number;
    periodicity: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
    startDate: string;
  }> = {},
) => ({
  downPayment: 0,
  installmentsCount: 3,
  periodicity: 'MONTHLY' as const,
  startDate: '2027-01-31T00:00:00.000Z',
  ...over,
});

const sumCents = (amounts: number[]) =>
  amounts.reduce((s, a) => s + toCents(a), 0);

describe('DX-041 · SimulateInstallmentsUseCase', () => {
  it('financia lo cobrable del plan aceptado: los propuestos cuentan como aceptados', async () => {
    const { simulate } = makePlan([
      { status: PROPOSED, price: 900, discount: 50 },
      { status: DONE, price: 250.5, discount: 0 },
    ]);
    const result = await simulate.execute('tp-1', [scenario()]);
    expect(result.totalToFinance).toBe(1100.5);
    expect(result.currency).toBe('USD');
  });

  it('igualdad: simular y dar de alta con los mismos datos dan las mismas cuotas y fechas', async () => {
    const plan = makePlan([
      { status: PROPOSED, price: 1000, discount: 0 },
      { status: PROPOSED, price: 333.33, discount: 0 },
    ]);
    const terms = [
      scenario({ downPayment: 200, installmentsCount: 7 }),
      scenario({ periodicity: 'BIWEEKLY', installmentsCount: 5 }),
      scenario({
        periodicity: 'WEEKLY',
        installmentsCount: 9,
        downPayment: 0.01,
      }),
    ];
    const simulation = await plan.simulate.execute('tp-1', terms);
    plan.accept();
    for (const [i, t] of terms.entries()) {
      const created = await plan.createPlan.execute(`tp-1`, t, 'u-1');
      const simulated = simulation.scenarios[i];
      expect(created.totalToFinance).toBe(simulated.totalToFinance);
      expect(created.downPayment).toBe(simulated.downPayment);
      expect(
        created.installments.map(({ sequence, dueDate, amount }) => ({
          sequence,
          dueDate: dueDate.toISOString(),
          amount,
        })),
      ).toEqual(
        simulated.installments.map(({ sequence, dueDate, amount }) => ({
          sequence,
          dueDate: dueDate.toISOString(),
          amount,
        })),
      );
      // Solo un plan activo: se cancela para probar el siguiente escenario.
      await plan.repo.cancel(created.id, {
        byId: 'u-1',
        at: new Date(),
        reason: 'Probar el siguiente escenario',
      });
    }
  });

  it('la inicial más las cuotas suman el saldo; el ajuste de redondeo va en la última', async () => {
    const { simulate } = makePlan([
      { status: PROPOSED, price: 1000, discount: 0 },
    ]);
    const result = await simulate.execute('tp-1', [
      scenario({ downPayment: 100, installmentsCount: 7 }),
    ]);
    const [s] = result.scenarios;
    const amounts = s.installments.map((i) => i.amount);
    expect(sumCents(amounts) + toCents(s.downPayment)).toBe(toCents(1000));
    // 900 / 7 = 128.57 × 6 y la última 128.58.
    expect(amounts.slice(0, 6).every((a) => a === 128.57)).toBe(true);
    expect(amounts[6]).toBe(128.58);
  });

  it('en VES (o cualquier moneda) reparte en unidades de su redondeo, como el alta', async () => {
    const { simulate } = makePlan(
      [{ status: PROPOSED, price: 12345.67, discount: 0 }],
      { currency: 'VES' },
    );
    const result = await simulate.execute('tp-1', [
      scenario({ installmentsCount: 4 }),
    ]);
    const amounts = result.scenarios[0].installments.map((i) => i.amount);
    expect(result.currency).toBe('VES');
    expect(sumCents(amounts)).toBe(toCents(12345.67));
  });

  it('fechas: mensual con tope a fin de mes, quincenal y semanal', async () => {
    const { simulate } = makePlan([
      { status: PROPOSED, price: 300, discount: 0 },
    ]);
    const result = await simulate.execute('tp-1', [
      scenario({ installmentsCount: 3 }),
      scenario({ periodicity: 'BIWEEKLY', installmentsCount: 2 }),
      scenario({ periodicity: 'WEEKLY', installmentsCount: 2 }),
    ]);
    const days = result.scenarios.map((s) =>
      s.installments.map((i) => i.dueDate.toISOString().slice(0, 10)),
    );
    expect(days).toEqual([
      ['2027-01-31', '2027-02-28', '2027-03-31'],
      ['2027-01-31', '2027-02-14'],
      ['2027-01-31', '2027-02-07'],
    ]);
  });

  it('simular no escribe: ni alta de plan de cuotas ni nada guardado', async () => {
    const { simulate, create, repo } = makePlan([
      { status: PROPOSED, price: 500, discount: 0 },
    ]);
    await simulate.execute('tp-1', [scenario(), scenario()]);
    expect(create).not.toHaveBeenCalled();
    await expect(repo.findActiveByPlan('tp-1')).resolves.toBeNull();
  });

  it('entre 1 y 3 escenarios (400)', async () => {
    const { simulate } = makePlan([
      { status: PROPOSED, price: 500, discount: 0 },
    ]);
    await expect(simulate.execute('tp-1', [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      simulate.execute('tp-1', [
        scenario(),
        scenario(),
        scenario(),
        scenario(),
      ]),
    ).rejects.toThrow('Simula entre 1 y 3 escenarios.');
  });

  it('valida como el alta: cuotas fuera de rango, inicial mayor que el saldo, plan sin importe (400)', async () => {
    const { simulate } = makePlan([
      { status: PROPOSED, price: 500, discount: 0 },
    ]);
    await expect(
      simulate.execute('tp-1', [scenario({ installmentsCount: 0 })]),
    ).rejects.toThrow('El número de cuotas debe estar entre 1 y 600.');
    await expect(
      simulate.execute('tp-1', [scenario({ downPayment: 500.01 })]),
    ).rejects.toBeInstanceOf(BadRequestException);
    const empty = makePlan([]);
    await expect(
      empty.simulate.execute('tp-1', [scenario()]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un plan rechazado no se financia y uno con plan de cuotas activo tampoco (409)', async () => {
    const rejected = makePlan([{ status: PROPOSED, price: 500, discount: 0 }], {
      status: TreatmentPlanStatus.REJECTED,
    });
    await expect(
      rejected.simulate.execute('tp-1', [scenario()]),
    ).rejects.toBeInstanceOf(ConflictException);

    const financed = makePlan([{ status: ACCEPTED, price: 500, discount: 0 }], {
      status: TreatmentPlanStatus.ACCEPTED,
    });
    await financed.createPlan.execute('tp-1', scenario(), 'u-1');
    await expect(
      financed.simulate.execute('tp-1', [scenario()]),
    ).rejects.toThrow(
      'Este plan de tratamiento ya tiene un plan de cuotas activo.',
    );
  });

  it('una moneda fuera del catálogo: 422, no un 500', async () => {
    const { simulate } = makePlan(
      [{ status: PROPOSED, price: 500, discount: 0 }],
      {
        currency: 'XXX',
        digits: {
          table: () =>
            Promise.resolve({
              has: () => false,
            } as unknown as CurrencyDigitsTable),
        },
      },
    );
    await expect(simulate.execute('tp-1', [scenario()])).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
