import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import type {
  PlanBalanceSnapshot,
  PlanAllocationRepository,
} from '../../domain/ports/plan-allocation-repository.port';
import { GetPlanBalanceUseCase } from './get-plan-balance.use-case';
import { BALANCE_CONVERSION_BUDGET_MS } from '../conversion-deadline';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { ExchangeRateUnavailableError } from '../../../exchange/domain/ports/exchange-rate-provider.port';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import { TreatmentPlanDetail } from '../../../treatment-plans/domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../../treatment-plans/domain/entities/treatment-plan-item.entity';
import { PLAN_WITHOUT_OPTIONS } from '../../../treatment-plans/application/use-cases/__fixtures__/in-memory-treatment-plan.repository';
import { round2 } from '../../../../shared/money/money';

class FakeGetTreatmentPlanUseCase {
  public plan: TreatmentPlanDetail | null = null;

  execute(): Promise<TreatmentPlanDetail> {
    if (!this.plan) {
      return Promise.reject(new NotFoundException('Treatment plan not found'));
    }
    return Promise.resolve(this.plan);
  }
}

interface FakeConvertInput {
  amount: number;
  from: string;
  to: string;
  date: string;
}

/**
 * Deterministic fake for `ConvertAmountUseCase`: fixed rate per source
 * currency (1 USD = 4000 COP by default), same-currency passthrough.
 * Records every call so specs can assert per-payment-date conversion --
 * mirrors sales/get-sales-totals.use-case.spec.ts's
 * FakeConvertAmountUseCase.
 *
 * IMP-4a regression: the REAL `ConvertAmountUseCase.rateUsed` is
 * amount-dependent -- `rateUsed = round2(amount * rate) / amount` -- because
 * it's derived from the ALREADY-ROUNDED result of THAT specific amount, not
 * a fixed exchange rate. A fake that returns a constant `rateUsed` can never
 * expose a bug where the use case reuses one payment's `rateUsed` for a
 * different payment's amount, so this fake reproduces the real per-amount
 * rounding behavior instead.
 */
class FakeConvertAmountUseCase {
  /** Como el real: el convertidor memoizado convierte igual (DX-374). */
  memoized(): this {
    return this;
  }

  public readonly calls: FakeConvertInput[] = [];
  /** Currencies (as `from`) that should make `execute` reject with the same
   * `BadRequestException` shape `ConvertAmountUseCase` throws for an
   * unsupported currency (IMP-4b). */
  public readonly failingFrom = new Set<string>();
  /** Currencies (as `from`) that should make `execute` reject with a
   * generic, non-currency error -- simulates an infra/DB failure that must
   * PROPAGATE rather than be swallowed as a skipped payment. */
  public readonly infraFailingFrom = new Set<string>();
  /** Currencies (as `from`) whose rates the provider cannot give (DX-051). */
  public readonly rateUnavailableFrom = new Set<string>();
  /** Currencies (as `from`) whose conversion never answers: a slow provider (DX-054). */
  public readonly hangingFrom = new Set<string>();
  /** units of `from` currency per 1 USD-equivalent `to`; mirrors
   * `rates[from]` in the real use case. */
  private readonly unitsPerTarget: Record<string, number> = { COP: 4000 };

  /** Test helper: register a fixed rate for a currency pair (units of
   * `from` per 1 unit of `to`), used by the mixed-amount regression test. */
  setRate(from: string, unitsPerTo: number): void {
    this.unitsPerTarget[from] = unitsPerTo;
  }

  execute(input: FakeConvertInput): Promise<{
    amount: number;
    from: string;
    to: string;
    date: string;
    result: number;
    rateUsed: number;
  }> {
    this.calls.push(input);
    if (this.hangingFrom.has(input.from)) {
      return new Promise(() => undefined);
    }
    if (this.infraFailingFrom.has(input.from)) {
      return Promise.reject(
        new Error(`simulated infra failure converting ${input.from}`),
      );
    }
    if (this.rateUnavailableFrom.has(input.from)) {
      return Promise.reject(new ExchangeRateUnavailableError('sin proveedor'));
    }
    if (this.failingFrom.has(input.from)) {
      return Promise.reject(
        new BadRequestException(`unsupported currency: ${input.from}`),
      );
    }
    if (input.from === input.to) {
      return Promise.resolve({ ...input, result: input.amount, rateUsed: 1 });
    }
    const unitsPerTo = this.unitsPerTarget[input.from];
    if (unitsPerTo === undefined) {
      throw new Error(
        `unsupported conversion in fake: ${input.from}->${input.to}`,
      );
    }
    const result = round2(input.amount / unitsPerTo);
    const rateUsed =
      input.amount !== 0 ? result / input.amount : 1 / unitsPerTo;
    return Promise.resolve({ ...input, result, rateUsed });
  }
}

class FakeAllocationRepository {
  public snapshot: PlanBalanceSnapshot | null = null;
  public readonly readPlanBalanceSnapshot = jest.fn(() =>
    Promise.resolve(this.snapshot),
  );
}

function makeItem(
  overrides: Partial<TreatmentPlanItem> = {},
): TreatmentPlanItem {
  return {
    id: 'item-1',
    tenantId: 't1',
    planId: 'plan-1',
    toothNumber: '11',
    surfaces: [],
    catalogItemId: 'cat-1',
    catalogPrice: null,
    basePrice: null,
    priceSource: null,
    agreementId: null,
    agreementName: null,
    pricingLocationId: null,
    price: 100,
    discount: 0,
    discountReason: null,
    discountReasonNote: null,
    discountById: null,
    discountAt: null,
    discountLocationId: null,
    status: TreatmentPlanItemStatus.PROPOSED,
    performedById: null,
    performedByName: null,
    performedLocationId: null,
    performedLocationName: null,
    completedAt: null,
    cancellationFeeAppointmentId: null,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makePlan(
  overrides: Partial<TreatmentPlanDetail> = {},
): TreatmentPlanDetail {
  return {
    id: 'plan-1',
    tenantId: 't1',
    patientId: 'patient-1',
    status: TreatmentPlanStatus.DRAFT,
    currency: 'USD',
    notes: null,
    createdById: null,
    ...PLAN_WITHOUT_OPTIONS,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    acceptance: null,
    items: [],
    total: 0,
    ...overrides,
  };
}

describe('GetPlanBalanceUseCase', () => {
  // Sede en UTC salvo que el caso pida otra: los casos antiguos fijan
  // instantes y esperan ese día UTC como fecha de la tasa.
  function makeUseCase(timeZone = 'UTC') {
    const repo = new InMemoryPaymentRepository(timeZone);
    const fakeGetPlan = new FakeGetTreatmentPlanUseCase();
    const fakeConvert = new FakeConvertAmountUseCase();
    const allocations = new FakeAllocationRepository();
    const uc = new GetPlanBalanceUseCase(
      repo,
      fakeGetPlan as unknown as GetTreatmentPlanUseCase,
      fakeConvert as unknown as ConvertAmountUseCase,
      allocations as unknown as PlanAllocationRepository,
    );
    return { repo, fakeGetPlan, fakeConvert, allocations, uc };
  }

  it('billable counts ONLY ACCEPTED and DONE items, never PROPOSED', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({
          id: 'i1',
          price: 100,
          status: TreatmentPlanItemStatus.PROPOSED,
        }),
        makeItem({
          id: 'i2',
          price: 200,
          status: TreatmentPlanItemStatus.ACCEPTED,
        }),
        makeItem({
          id: 'i3',
          price: 300,
          status: TreatmentPlanItemStatus.DONE,
        }),
      ],
    });

    const result = await uc.execute('plan-1');

    expect(result.billable).toBe(500);
    expect(result.planCurrency).toBe('USD');
  });

  it('billable resta el descuento de cada ítem (DX-012)', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({
          price: 200,
          discount: 20.5,
          discountReason: null,
          discountReasonNote: null,
          discountById: null,
          discountAt: null,
          discountLocationId: null,
          status: TreatmentPlanItemStatus.ACCEPTED,
        }),
        makeItem({
          price: 100,
          discount: 100,
          discountReason: null,
          discountReasonNote: null,
          discountById: null,
          discountAt: null,
          discountLocationId: null,
          status: TreatmentPlanItemStatus.DONE,
        }),
        makeItem({
          price: 50,
          discount: 10,
          discountReason: null,
          discountReasonNote: null,
          discountById: null,
          discountAt: null,
          discountLocationId: null,
          status: TreatmentPlanItemStatus.PROPOSED,
        }),
      ],
    });

    const result = await uc.execute('plan-1');

    expect(result.billable).toBe(179.5);
    expect(result.balance).toBe(179.5);
  });

  it('DX-097 (H2): la tasa es la del día civil del abono en su sede, igual que el dashboard', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } =
      makeUseCase('America/Bogota');
    fakeGetPlan.plan = makePlan({
      items: [makeItem({ price: 1000, status: TreatmentPlanItemStatus.DONE })],
    });
    // 05/03 a las 20:00 en la zona de la sede = 06/03 01:00 UTC.
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 400000,
      currency: 'COP',
      paidAt: new Date('2026-03-06T01:00:00.000Z'),
    });

    await uc.execute('plan-1');

    expect(fakeConvert.calls.map((c) => c.date)).toEqual(['2026-03-05']);
  });

  it("paid = Σ payments converted to plan currency by each payment's own paidAt date", async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({ price: 1000, status: TreatmentPlanItemStatus.ACCEPTED }),
      ],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 400000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T12:00:00.000Z'),
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 30,
      currency: 'USD',
      paidAt: new Date('2026-03-10T08:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    // 400000 COP / 4000 = 100 USD, plus 30 USD passthrough = 130.
    expect(result.paid).toBe(130);
    expect(result.billable).toBe(1000);
    expect(result.balance).toBe(870);
    expect(result.paymentsCount).toBe(2);
    // DX-375: el de USD está en la moneda del plan y no se convierte.
    expect(fakeConvert.calls).toEqual([
      { amount: 400000, from: 'COP', to: 'USD', date: '2026-03-05' },
    ]);
  });

  it('excludes a voided payment from paid/balance', async () => {
    const { repo, fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [makeItem({ price: 500, status: TreatmentPlanItemStatus.DONE })],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 200,
      currency: 'USD',
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 999,
      currency: 'USD',
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    expect(result.paid).toBe(200);
    expect(result.balance).toBe(300);
    expect(result.paymentsCount).toBe(1);
  });

  it('returns billable=0, paid=0, balance=0 for a plan with no items and no payments', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    const result = await uc.execute('plan-1');

    expect(result).toEqual({
      planCurrency: 'USD',
      billable: 0,
      paid: 0,
      balance: 0,
      creditMovements: 0,
      paymentsCount: 0,
      paymentsWithoutRate: [],
      rateProviderTimedOut: false,
    });
  });

  it('propagates NotFoundException when the plan is absent', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = null;

    await expect(uc.execute('missing-plan')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // IMP-4a follow-up: each payment is converted FRESH (own amount, own
  // paidAt date) -- NOT memoized/reused from another payment sharing the
  // same date+currency.
  it('converts each payment independently, even when several share the same date and currency', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({ price: 1000, status: TreatmentPlanItemStatus.ACCEPTED }),
      ],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 400000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T09:00:00.000Z'),
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 200000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T18:00:00.000Z'),
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 40000,
      currency: 'COP',
      paidAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    // 400000/4000 + 200000/4000 + 40000/4000 = 100 + 50 + 10 = 160.
    expect(result.paid).toBe(160);
    expect(result.paymentsCount).toBe(3);
    // One convertAmount.execute() call PER PAYMENT -- no memoization/reuse
    // across payments sharing a date+currency.
    expect(fakeConvert.calls).toHaveLength(3);
  });

  // IMP-4a regression: memoizing `rateUsed` per (date, currency) and
  // reapplying it via `round2(amount * cachedRateUsed)` reproduces the
  // FIRST-PROCESSED payment's rounding for every other payment sharing that
  // pair, drifting the total whenever amounts don't divide evenly by the
  // rate. With amounts [1, 2, 5, 7, 100, 333] at a fixed 3-units-per-USD
  // rate, fresh-per-payment conversion sums 0.33+0.67+1.67+2.33+33.33+111 =
  // 149.33, while memoizing the first-processed payment's (amount=1)
  // rateUsed=0.33 against the rest sums to 147.84. This test asserts the
  // correct (fresh-per-payment) total and FAILS under the memoized
  // implementation. `listByPlan` orders DESC by paidAt (see the other
  // tests above), so the amount=1 payment is given the LATEST paidAt to
  // make it the first one processed.
  it('sums independently-rounded conversions for mixed amounts sharing a date/currency (no rate memoization drift)', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeConvert.setRate('AAA', 3);
    fakeGetPlan.plan = makePlan({
      items: [
        makeItem({ price: 1000, status: TreatmentPlanItemStatus.ACCEPTED }),
      ],
    });
    const amounts = [1, 2, 5, 7, 100, 333];
    amounts.forEach((amount, i) => {
      repo.seedPayment({
        treatmentPlanId: 'plan-1',
        amount,
        currency: 'AAA',
        paidAt: new Date(
          `2026-03-05T${String(amounts.length - 1 - i).padStart(2, '0')}:00:00.000Z`,
        ),
      });
    });

    const result = await uc.execute('plan-1');

    const expectedPaid = round2(
      amounts.reduce((sum, amount) => sum + round2(amount / 3), 0),
    );
    expect(expectedPaid).toBe(149.33);
    expect(result.paid).toBe(149.33);
    expect(result.paid).toBe(expectedPaid);
    expect(fakeConvert.calls).toHaveLength(amounts.length);
  });

  // IMP-4b: one payment with an unsupported currency must not throw and
  // fail the whole balance computation -- it should be skipped instead.
  it('skips a payment whose currency conversion fails, keeping the rest of paid/balance', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeConvert.failingFrom.add('ZZZ');
    fakeGetPlan.plan = makePlan({
      items: [makeItem({ price: 500, status: TreatmentPlanItemStatus.DONE })],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 100,
      currency: 'USD',
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 999,
      currency: 'ZZZ',
      paidAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    expect(result.paid).toBe(100);
    expect(result.balance).toBe(400);
    // `paymentsCount` is unaffected by conversion failures -- it reflects
    // how many active payments exist, not how many could be converted.
    expect(result.paymentsCount).toBe(2);
  });

  // DX-051: si el proveedor no puede dar la tasa (y no hay una guardada para
  // esa fecha) el saldo no falla: el abono se omite como el de una moneda sin
  // tasa. Solo ese fallo y «moneda sin tasa»; cualquier otro se propaga.
  it('skips a payment whose rate the provider cannot give instead of failing the balance', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeConvert.rateUnavailableFrom.add('COP');
    fakeGetPlan.plan = makePlan({
      items: [makeItem({ price: 500, status: TreatmentPlanItemStatus.DONE })],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 400000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    const result = await uc.execute('plan-1');

    expect(result.paid).toBe(0);
    expect(result.paymentsCount).toBe(1);
  });

  describe('DX-054: proveedor de tasas lento', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it(`a los ${BALANCE_CONVERSION_BUDGET_MS} ms responde sin esperar: los abonos sin convertir salen marcados y no suman`, async () => {
      const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
      fakeConvert.hangingFrom.add('COP');
      fakeGetPlan.plan = makePlan({
        currency: 'USD',
        items: [makeItem({ price: 500, status: TreatmentPlanItemStatus.DONE })],
      });
      repo.seedPayment({
        treatmentPlanId: 'plan-1',
        amount: 100,
        currency: 'USD',
        paidAt: new Date('2026-03-05T12:00:00.000Z'),
      });
      const slow = repo.seedPayment({
        treatmentPlanId: 'plan-1',
        amount: 400000,
        currency: 'COP',
        paidAt: new Date('2026-03-06T12:00:00.000Z'),
      });

      const pending = uc.execute('plan-1');
      await jest.advanceTimersByTimeAsync(BALANCE_CONVERSION_BUDGET_MS);
      const result = await pending;

      expect(result.paid).toBe(100);
      expect(result.balance).toBe(400);
      expect(result.paymentsCount).toBe(2);
      expect(result.rateProviderTimedOut).toBe(true);
      expect(result.paymentsWithoutRate).toEqual([
        {
          paymentId: slow.id,
          amount: 400000,
          currency: 'COP',
          paidOn: '2026-03-06',
        },
      ]);
    });

    it('el plazo es de todo el saldo, no por abono: un segundo abono lento no lo alarga', async () => {
      const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
      fakeConvert.hangingFrom.add('COP');
      fakeGetPlan.plan = makePlan({ currency: 'USD' });
      for (const day of ['2026-03-05', '2026-03-06']) {
        repo.seedPayment({
          treatmentPlanId: 'plan-1',
          amount: 400000,
          currency: 'COP',
          paidAt: new Date(`${day}T12:00:00.000Z`),
        });
      }

      const pending = uc.execute('plan-1');
      await jest.advanceTimersByTimeAsync(BALANCE_CONVERSION_BUDGET_MS);
      const result = await pending;

      expect(result.paid).toBe(0);
      expect(result.paymentsWithoutRate).toHaveLength(2);
      expect(result.rateProviderTimedOut).toBe(true);
    });

    it('vencido el plazo no se pide ninguna conversión más al proveedor', async () => {
      const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
      fakeConvert.hangingFrom.add('COP');
      fakeGetPlan.plan = makePlan({ currency: 'USD' });
      for (const day of ['2026-03-05', '2026-03-06', '2026-03-07']) {
        repo.seedPayment({
          treatmentPlanId: 'plan-1',
          amount: 400000,
          currency: 'COP',
          paidAt: new Date(`${day}T12:00:00.000Z`),
        });
      }

      const pending = uc.execute('plan-1');
      await jest.advanceTimersByTimeAsync(BALANCE_CONVERSION_BUDGET_MS);
      const result = await pending;

      expect(fakeConvert.calls).toHaveLength(1);
      expect(result.paymentsWithoutRate).toHaveLength(3);
    });

    it('sin conversiones lentas no marca nada ni deja temporizadores vivos', async () => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan({ currency: 'USD' });
      repo.seedPayment({
        treatmentPlanId: 'plan-1',
        amount: 400000,
        currency: 'COP',
        paidAt: new Date('2026-03-05T12:00:00.000Z'),
      });

      const result = await uc.execute('plan-1');

      expect(result.paid).toBe(100);
      expect(result.rateProviderTimedOut).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('propagates a generic conversion error instead of silently skipping the payment', async () => {
    const { repo, fakeGetPlan, fakeConvert, uc } = makeUseCase();
    fakeConvert.infraFailingFrom.add('COP');
    fakeGetPlan.plan = makePlan({
      items: [makeItem({ price: 500, status: TreatmentPlanItemStatus.DONE })],
    });
    repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 400000,
      currency: 'COP',
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    await expect(uc.execute('plan-1')).rejects.toThrow(
      'simulated infra failure converting COP',
    );
  });

  it.each([TreatmentPlanStatus.REJECTED, TreatmentPlanStatus.CANCELLED])(
    'DX-109: un plan %s tiene billable 0 y sus abonos siguen en paid',
    async (status) => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan({
        status,
        items: [
          makeItem({ price: 1000, status: TreatmentPlanItemStatus.ACCEPTED }),
        ],
      });
      repo.seedPayment({ treatmentPlanId: 'plan-1', amount: 300 });

      const result = await uc.execute('plan-1');

      expect(result).toMatchObject({
        billable: 0,
        paid: 300,
        balance: -300,
        paymentsCount: 1,
      });
    },
  );

  it('DX-109: un plan COMPLETED sigue siendo cobrable', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({
      status: TreatmentPlanStatus.COMPLETED,
      items: [makeItem({ price: 1000, status: TreatmentPlanItemStatus.DONE })],
    });
    expect((await uc.execute('plan-1')).billable).toBe(1000);
  });

  describe('executeWithItems (DX-051)', () => {
    type Snap = Partial<PlanBalanceSnapshot>;
    const item = (
      id: string,
      status: TreatmentPlanItemStatus,
      price: number,
      extra: Partial<PlanBalanceSnapshot['items'][number]> = {},
    ) => ({
      id,
      toothNumber: '11',
      procedureName: `Proc ${id}`,
      status,
      price,
      discount: 0,
      ...extra,
    });
    const pay = (id: string, amount: number) => ({
      id,
      amount,
      currency: 'USD',
      paidOn: '2026-03-05',
      exchangeRateCurrency: 'USD',
      frozenRate: null,
    });
    function seed(
      allocations: FakeAllocationRepository,
      over: Snap = {},
    ): void {
      allocations.snapshot = {
        plan: { status: TreatmentPlanStatus.ACCEPTED, currency: 'USD' },
        items: [
          item('i1', TreatmentPlanItemStatus.DONE, 100),
          item('i2', TreatmentPlanItemStatus.ACCEPTED, 50, { discount: 10 }),
          item('i3', TreatmentPlanItemStatus.PROPOSED, 70, {
            toothNumber: '22',
          }),
        ],
        payments: [],
        allocations: [],
        bases: [],
        ...over,
      };
    }

    it('returns per-item figures with procedure name in plan order', async () => {
      const { allocations, uc } = makeUseCase();
      seed(allocations, {
        // Ítems fuera de orden alfabético y de id: el orden es el del plan.
        items: [
          item('z', TreatmentPlanItemStatus.ACCEPTED, 50, {
            discount: 10,
            procedureName: 'Endodoncia',
          }),
          item('a', TreatmentPlanItemStatus.DONE, 100, {
            procedureName: 'Resina',
          }),
          item('m', TreatmentPlanItemStatus.PROPOSED, 70, {
            toothNumber: '22',
            procedureName: 'Corona',
          }),
        ],
        payments: [pay('p1', 120)],
        bases: [{ paymentId: 'p1', amount: 120, manual: false }],
        allocations: [
          { paymentId: 'p1', itemId: 'a', amount: 100 },
          { paymentId: 'p1', itemId: 'z', amount: 20 },
        ],
      });

      const result = await uc.executeWithItems('plan-1');

      expect(result.items).toEqual([
        {
          itemId: 'z',
          toothNumber: '11',
          procedureName: 'Endodoncia',
          status: 'ACCEPTED',
          billable: 40,
          paid: 20,
          balance: 20,
        },
        {
          itemId: 'a',
          toothNumber: '11',
          procedureName: 'Resina',
          status: 'DONE',
          billable: 100,
          paid: 100,
          balance: 0,
        },
        {
          itemId: 'm',
          toothNumber: '22',
          procedureName: 'Corona',
          status: 'PROPOSED',
          billable: 0,
          paid: 0,
          balance: 0,
        },
      ]);
      expect(result).toMatchObject({ billable: 140, paid: 120, balance: 20 });
    });

    it('PROPOSED items report zeros', async () => {
      const { allocations, uc } = makeUseCase();
      seed(allocations);

      const proposed = (await uc.executeWithItems('plan-1')).items[2];

      expect(proposed).toMatchObject({ billable: 0, paid: 0, balance: 0 });
    });

    it('non-billable plan reports zero billable items and everything unallocated', async () => {
      const { allocations, uc } = makeUseCase();
      seed(allocations, {
        plan: { status: TreatmentPlanStatus.CANCELLED, currency: 'USD' },
        payments: [pay('p1', 80)],
        bases: [{ paymentId: 'p1', amount: 80, manual: false }],
      });

      const result = await uc.executeWithItems('plan-1');

      expect(result.items.every((i) => i.billable === 0)).toBe(true);
      expect(result).toMatchObject({ allocated: 0, unallocated: 80 });
    });

    it('unallocated sums payment surpluses', async () => {
      const { allocations, uc } = makeUseCase();
      seed(allocations, {
        payments: [pay('a', 100), pay('b', 60)],
        bases: [
          { paymentId: 'a', amount: 100, manual: false },
          { paymentId: 'b', amount: 60, manual: false },
        ],
        allocations: [
          { paymentId: 'a', itemId: 'i1', amount: 90 },
          { paymentId: 'b', itemId: 'i2', amount: 40 },
        ],
      });

      expect(await uc.executeWithItems('plan-1')).toMatchObject({
        allocated: 130,
        unallocated: 30,
      });
    });

    it('invariant: sum of item paid plus unallocated equals paid', async () => {
      const { allocations, uc, fakeConvert } = makeUseCase();
      fakeConvert.setRate('COP', 4000);
      // Abono en COP convertido en vivo: 400000 COP = 100 USD = su base.
      seed(allocations, {
        payments: [
          {
            id: 'a',
            amount: 400000,
            currency: 'COP',
            paidOn: '2026-03-05',
            exchangeRateCurrency: null,
            frozenRate: null,
          },
          pay('b', 59.9),
        ],
        bases: [
          { paymentId: 'a', amount: 100, manual: false },
          { paymentId: 'b', amount: 59.9, manual: false },
        ],
        allocations: [
          { paymentId: 'a', itemId: 'i1', amount: 100 },
          { paymentId: 'b', itemId: 'i2', amount: 40 },
        ],
      });

      const result = await uc.executeWithItems('plan-1');

      const sum = result.items.reduce((s, i) => s + i.paid * 100, 0);
      expect(Math.round(sum + result.unallocated * 100)).toBe(
        Math.round(result.paid * 100),
      );
      expect(result.paid).toBe(159.9);
    });

    it('derives paid, items and payments only from the snapshot', async () => {
      const { repo, fakeGetPlan, allocations, uc } = makeUseCase();
      // El repositorio de abonos y el caso de uso del plan tienen otra foto:
      // no se consultan.
      fakeGetPlan.plan = makePlan({ items: [] });
      repo.seedPayment({ treatmentPlanId: 'plan-1', amount: 999 });
      seed(allocations, {
        payments: [pay('p1', 30)],
        bases: [{ paymentId: 'p1', amount: 30, manual: false }],
        allocations: [{ paymentId: 'p1', itemId: 'i1', amount: 30 }],
      });

      const result = await uc.executeWithItems('plan-1');

      expect(result).toMatchObject({ paid: 30, paymentsCount: 1 });
      expect(result.items).toHaveLength(3);
      expect(result.items[0]).toMatchObject({ paid: 30, balance: 70 });
      expect(allocations.readPlanBalanceSnapshot).toHaveBeenCalledTimes(1);
    });

    it('throws NotFound when the snapshot has no plan', async () => {
      const { uc } = makeUseCase();

      await expect(uc.executeWithItems('plan-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // BE-050 (DX-375): el abono con base cuenta en `paid` por su base, así lo
    // cobrado y el desglose por ítem no descuadran aunque la tasa cambie.
    it('paid usa la base del abono: lo imputado más lo sin imputar es lo cobrado (BE-050)', async () => {
      const { allocations, uc, fakeConvert } = makeUseCase();
      fakeConvert.setRate('COP', 5000);
      seed(allocations, {
        payments: [
          {
            id: 'p1',
            amount: 400000,
            currency: 'COP',
            paidOn: '2026-03-05',
            exchangeRateCurrency: null,
            frozenRate: null,
          },
        ],
        bases: [{ paymentId: 'p1', amount: 100, manual: false }],
        allocations: [{ paymentId: 'p1', itemId: 'i1', amount: 60 }],
      });

      const result = await uc.executeWithItems('plan-1');

      expect(result.paid).toBe(100);
      expect(result.allocated + result.unallocated).toBe(result.paid);
      expect(fakeConvert.calls).toEqual([]);
    });

    it('un abono «sin tasa» no cuenta en paid y sale en paymentsWithoutRate (DX-375)', async () => {
      const { allocations, uc, fakeConvert } = makeUseCase();
      fakeConvert.setRate('COP', 4000);
      seed(allocations, {
        payments: [
          pay('usd', 10),
          {
            id: 'cop',
            amount: 40000,
            currency: 'COP',
            paidOn: '2026-03-06',
            exchangeRateCurrency: 'USD',
            frozenRate: null,
          },
        ],
        bases: [{ paymentId: 'usd', amount: 10, manual: false }],
      });

      const result = await uc.executeWithItems('plan-1');

      expect(result.paid).toBe(10);
      expect(result.paymentsCount).toBe(2);
      expect(result.paymentsWithoutRate).toEqual([
        {
          paymentId: 'cop',
          amount: 40000,
          currency: 'COP',
          paidOn: '2026-03-06',
        },
      ]);
      expect(fakeConvert.calls).toEqual([]);
    });

    it('counts payments without base', async () => {
      const { allocations, uc } = makeUseCase();
      seed(allocations, {
        payments: [pay('p1', 10), pay('p2', 25)],
        bases: [{ paymentId: 'p1', amount: 10, manual: false }],
      });

      const result = await uc.executeWithItems('plan-1');

      expect(result.unconvertedPaymentsCount).toBe(1);
      expect(result.unallocated).toBe(10);
    });

    it('lists manual payment ids', async () => {
      const { allocations, uc } = makeUseCase();
      seed(allocations, {
        payments: [pay('a', 10), pay('b', 20)],
        bases: [
          { paymentId: 'a', amount: 10, manual: false },
          { paymentId: 'b', amount: 20, manual: true },
        ],
      });

      expect((await uc.executeWithItems('plan-1')).manualPaymentIds).toEqual([
        'b',
      ]);
    });

    it('execute is unchanged and does not read allocations', async () => {
      const { repo, fakeGetPlan, allocations, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan({
        items: [
          makeItem({ price: 100, status: TreatmentPlanItemStatus.ACCEPTED }),
        ],
      });
      repo.seedPayment({ treatmentPlanId: 'plan-1', amount: 20 });

      const result = await uc.execute('plan-1');

      expect(Object.keys(result).sort()).toEqual([
        'balance',
        'billable',
        'creditMovements',
        'paid',
        'paymentsCount',
        'paymentsWithoutRate',
        'planCurrency',
        'rateProviderTimedOut',
      ]);
      expect(allocations.readPlanBalanceSnapshot).not.toHaveBeenCalled();
    });
  });
});
