import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { RecordPaymentUseCase } from './record-payment.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { TreatmentPlanDetail } from '../../../treatment-plans/domain/entities/treatment-plan.entity';
import { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import { PLAN_WITHOUT_OPTIONS } from '../../../treatment-plans/application/use-cases/__fixtures__/in-memory-treatment-plan.repository';
import type { ReceiptPlanBalanceCalculator } from '../receipts/receipt-plan-balance';
import type { ReceiptPlanBalance } from '../../domain/receipt-snapshot';
import type { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import { Logger } from '@nestjs/common';

/** Fake del saldo del recibo (DX-136): devuelve lo que se le diga y anota las llamadas. */
class FakeReceiptPlanBalance {
  public result: ReceiptPlanBalance | null = {
    currency: 'USD',
    billable: 1000,
    paid: 150,
    balance: 850,
  };
  public readonly calls: {
    treatmentPlanId: string;
    convertedAmount: number | null;
  }[] = [];

  afterPayment(
    treatmentPlanId: string,
    convertedAmount: number | null,
  ): Promise<ReceiptPlanBalance | null> {
    this.calls.push({ treatmentPlanId, convertedAmount });
    return Promise.resolve(this.result);
  }
}

/**
 * Fake for `GetTreatmentPlanUseCase` -- concrete class (not an interface
 * port), so a plain object literal isn't structurally assignable to it.
 * Cast via `as unknown as GetTreatmentPlanUseCase` at the injection site,
 * same pattern as FakeConvertAmountUseCase in the old
 * sales/get-sales-totals.use-case.spec.ts.
 */
class FakeGetTreatmentPlanUseCase {
  public plan: TreatmentPlanDetail | null = null;
  public readonly calls: string[] = [];

  execute(id: string): Promise<TreatmentPlanDetail> {
    this.calls.push(id);
    if (!this.plan) {
      return Promise.reject(new NotFoundException('Treatment plan not found'));
    }
    return Promise.resolve(this.plan);
  }
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

// Fake whitelist: allows the codes actually exercised by this suite. `has`
// is case-sensitive here on purpose, to catch a regression where the use
// case forgets to `.toUpperCase()` BEFORE calling it.
function makeWhitelist(allowed: string[] = ['USD', 'COP']): CurrencyWhitelist {
  return {
    has: (code: string): Promise<boolean> =>
      Promise.resolve(allowed.includes(code)),
  };
}

/** Fake de la conversión: tasa fija por moneda de origen; anota las llamadas. */
class FakeConvertAmount {
  public rates: Record<string, number> = {};
  public failure: Error | null = null;
  public readonly calls: {
    amount: number;
    from: string;
    to: string;
    date: string;
  }[] = [];

  execute(input: { amount: number; from: string; to: string; date: string }) {
    this.calls.push(input);
    if (this.failure) return Promise.reject(this.failure);
    const rateUsed = input.from === input.to ? 1 : this.rates[input.from];
    return Promise.resolve({ ...input, result: 0, rateUsed });
  }
}

describe('RecordPaymentUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryPaymentRepository();
    const fakeGetPlan = new FakeGetTreatmentPlanUseCase();
    const receiptBalance = new FakeReceiptPlanBalance();
    const convert = new FakeConvertAmount();
    const uc = new RecordPaymentUseCase(
      repo,
      fakeGetPlan as unknown as GetTreatmentPlanUseCase,
      makeWhitelist(),
      receiptBalance as unknown as ReceiptPlanBalanceCalculator,
      convert as unknown as ConvertAmountUseCase,
    );
    return { repo, fakeGetPlan, uc, receiptBalance, convert };
  }

  describe('DX-051: base del abono en la moneda del plan', () => {
    afterEach(() => jest.restoreAllMocks());

    it('passes planAmount converted at paidOn', async () => {
      const { repo, fakeGetPlan, uc, convert } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1', currency: 'USD' });
      convert.rates = { COP: 1 / 4000 };

      await uc.execute(
        'plan-1',
        { amount: 401_234, currency: 'cop', paidAt: '2026-03-05' },
        'user-1',
      );

      expect(convert.calls).toEqual([
        { amount: 401_234, from: 'COP', to: 'USD', date: '2026-03-05' },
      ]);
      expect(repo.lastCreateInput?.planAmount).toEqual({
        planCurrency: 'USD',
        amount: 100.31,
        rateDate: '2026-03-05',
      });
    });

    it('passes null when conversion throws and still records', async () => {
      const { repo, fakeGetPlan, uc, convert } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1', currency: 'USD' });
      convert.failure = new Error('proveedor caído');
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const payment = await uc.execute(
        'plan-1',
        { amount: 50_000, currency: 'COP', paidAt: '2026-03-05' },
        'user-1',
      );

      expect(payment.amount).toBe(50_000);
      expect(repo.lastCreateInput?.planAmount).toBeNull();
      // Sin datos del abono ni del paciente: solo el tipo del error.
      expect(warn).toHaveBeenCalledWith({
        event: 'payments.allocation_base_unavailable',
        error: 'Error',
      });
    });
  });

  describe('DX-136: saldo del plan para el recibo', () => {
    it('pasa al repositorio el saldo tras el abono, calculado con el día civil del abono en su sede', async () => {
      const { repo, fakeGetPlan, uc, receiptBalance } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1' });

      await uc.execute(
        'plan-1',
        { amount: 150, currency: 'usd', paidAt: '2026-03-05' },
        'user-1',
      );

      expect(receiptBalance.calls).toEqual([
        { treatmentPlanId: 'plan-1', convertedAmount: 150 },
      ]);
      expect(repo.lastCreateInput?.receiptPlanBalance).toEqual({
        currency: 'USD',
        billable: 1000,
        paid: 150,
        balance: 850,
      });
    });

    it('sin saldo (null) el abono se registra igual', async () => {
      const { repo, fakeGetPlan, uc, receiptBalance } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1' });
      receiptBalance.result = null;

      const payment = await uc.execute('plan-1', {
        amount: 10,
        currency: 'USD',
        paidAt: '2026-03-05T15:00:00.000Z',
      });

      expect(payment.amount).toBe(10);
      expect(repo.lastCreateInput?.receiptPlanBalance).toBeNull();
    });

    it('una repetición idempotente no vuelve a calcular el saldo', async () => {
      const { fakeGetPlan, uc, receiptBalance } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1' });
      const key = '6f1c2b9e-8a4d-4c1e-9f0a-1b2c3d4e5f60';
      const body = { amount: 10, currency: 'USD', paidAt: '2026-03-05' };

      await uc.execute('plan-1', body, 'u1', key);
      await uc.execute('plan-1', body, 'u1', key);

      expect(receiptBalance.calls).toHaveLength(1);
    });
  });

  it('records a payment against an existing plan, deriving patientId from the plan', async () => {
    const { repo, fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan({ id: 'plan-1', patientId: 'patient-9' });

    const payment = await uc.execute(
      'plan-1',
      {
        amount: 150,
        currency: 'usd',
        paidAt: '2026-03-05T00:00:00.000Z',
        notes: 'primer abono',
      },
      'user-1',
    );

    expect(payment.treatmentPlanId).toBe('plan-1');
    expect(payment.patientId).toBe('patient-9');
    expect(payment.amount).toBe(150);
    expect(payment.currency).toBe('USD');
    expect(payment.createdById).toBe('user-1');

    const listed = await repo.listByPlan('plan-1');
    expect(listed).toHaveLength(1);
  });

  it('rejects amount <= 0 with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 0,
        currency: 'USD',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      uc.execute('plan-1', {
        amount: -10,
        currency: 'USD',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-finite amount with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: Number.POSITIVE_INFINITY,
        currency: 'USD',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a blank currency with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 10,
        currency: '   ',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown currency with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 10,
        currency: 'XXX',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid paidAt with BadRequestException', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 10,
        currency: 'USD',
        paidAt: 'not-a-date',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('DX-097: un paidAt solo con fecha (YYYY-MM-DD) se guarda al mediodía de la sede, dentro de ese día civil', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    const payment = await uc.execute('plan-1', {
      amount: 10,
      currency: 'USD',
      paidAt: '2026-10-16',
    });

    // Sede del fake en Bogotá (UTC-5): 12:00 locales = 17:00 UTC.
    expect(payment.paidAt.toISOString()).toBe('2026-10-16T17:00:00.000Z');
  });

  it('DX-097: un paidAt con hora es un instante y se guarda tal cual', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    const payment = await uc.execute('plan-1', {
      amount: 10,
      currency: 'USD',
      paidAt: '2026-10-17T01:00:00.000Z',
    });

    expect(payment.paidAt.toISOString()).toBe('2026-10-17T01:00:00.000Z');
  });

  it('DX-097 (B1): una medianoche UTC exacta (web anterior) es un día civil: mediodía de la sede', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    const payment = await uc.execute('plan-1', {
      amount: 10,
      currency: 'USD',
      paidAt: '2026-10-16T00:00:00.000Z',
    });

    expect(payment.paidAt.toISOString()).toBe('2026-10-16T17:00:00.000Z');
    expect(payment.paidOn).toBe('2026-10-16');
  });

  it('rechaza una hora sin Z ni desfase (se leería en la zona del servidor)', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 10,
        currency: 'USD',
        paidAt: '2026-10-16T20:00:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un día que no existe (2026-02-30)', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = makePlan();

    await expect(
      uc.execute('plan-1', {
        amount: 10,
        currency: 'USD',
        paidAt: '2026-02-30',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('propagates NotFoundException when the plan is absent', async () => {
    const { fakeGetPlan, uc } = makeUseCase();
    fakeGetPlan.plan = null;

    await expect(
      uc.execute('missing-plan', {
        amount: 10,
        currency: 'USD',
        paidAt: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('idempotency', () => {
    it('records the Idempotency-Key so it can be looked up', async () => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1', patientId: 'patient-1' });
      const key = '11111111-1111-1111-1111-111111111111';

      const created = await uc.execute(
        'plan-1',
        { amount: 100, currency: 'USD', paidAt: '2026-03-05T00:00:00.000Z' },
        'user-1',
        key,
      );

      const found = await repo.findByIdempotencyKey(key);
      expect(found?.payment.id).toBe(created.id);
    });

    it('returns the EXISTING payment on replay of the same key (no second row, no plan re-check)', async () => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1', patientId: 'patient-1' });
      const key = '22222222-2222-2222-2222-222222222222';

      const first = await uc.execute(
        'plan-1',
        { amount: 100, currency: 'USD', paidAt: '2026-03-05T00:00:00.000Z' },
        'user-1',
        key,
      );

      // Plan gone on the retry (voided after the first write): the short-circuit
      // must NOT re-check the plan, so this still resolves to the original.
      fakeGetPlan.plan = null;
      const replay = await uc.execute(
        'plan-1',
        { amount: 100, currency: 'USD', paidAt: '2026-03-05T00:00:00.000Z' },
        'user-1',
        key,
      );

      expect(replay.id).toBe(first.id);
      expect(await repo.listByPlan('plan-1')).toHaveLength(1);
      expect(fakeGetPlan.calls).toEqual(['plan-1']); // plan looked up only once
    });

    it('creates a distinct payment for a DIFFERENT key', async () => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1', patientId: 'patient-1' });

      await uc.execute(
        'plan-1',
        { amount: 100, currency: 'USD', paidAt: '2026-03-05T00:00:00.000Z' },
        'user-1',
        '33333333-3333-3333-3333-333333333333',
      );
      await uc.execute(
        'plan-1',
        { amount: 100, currency: 'USD', paidAt: '2026-03-05T00:00:00.000Z' },
        'user-1',
        '44444444-4444-4444-4444-444444444444',
      );

      expect(await repo.listByPlan('plan-1')).toHaveLength(2);
    });

    it('rejects a non-UUID key with BadRequestException', async () => {
      const { fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan();

      await expect(
        uc.execute(
          'plan-1',
          { amount: 100, currency: 'USD', paidAt: '2026-03-05T00:00:00.000Z' },
          'user-1',
          'not-a-uuid',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('records normally when no key is provided (key stays absent)', async () => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan({ id: 'plan-1', patientId: 'patient-1' });

      await uc.execute(
        'plan-1',
        { amount: 100, currency: 'USD', paidAt: '2026-03-05T00:00:00.000Z' },
        'user-1',
      );

      expect(await repo.listByPlan('plan-1')).toHaveLength(1);
    });
  });

  describe('DX-109: planes no cobrables', () => {
    it.each([TreatmentPlanStatus.REJECTED, TreatmentPlanStatus.CANCELLED])(
      'un abono sobre un plan %s es 409 en español y no se guarda',
      async (status) => {
        const { repo, fakeGetPlan, uc } = makeUseCase();
        fakeGetPlan.plan = makePlan({ status });
        const attempt = uc.execute('plan-1', {
          amount: 10,
          currency: 'USD',
          paidAt: '2026-03-05',
        });
        await expect(attempt).rejects.toBeInstanceOf(ConflictException);
        await expect(attempt).rejects.toThrow(/no admite abonos/);
        expect(await repo.listByPlan('plan-1')).toHaveLength(0);
      },
    );

    it('COMPLETED sigue admitiendo abonos', async () => {
      const { fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan({ status: TreatmentPlanStatus.COMPLETED });
      const payment = await uc.execute('plan-1', {
        amount: 10,
        currency: 'USD',
        paidAt: '2026-03-05',
      });
      expect(payment.amount).toBe(10);
    });
  });

  describe('DX-109: huella de la Idempotency-Key', () => {
    const key = '22222222-2222-2222-2222-222222222222';
    const body = { amount: 100, currency: 'usd', paidAt: '2026-03-05' };

    it('la repetición idéntica (misma petición normalizada) devuelve el original', async () => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan();
      const first = await uc.execute('plan-1', body, 'u1', key);
      const again = await uc.execute(
        'plan-1',
        { ...body, currency: ' USD ', amount: 100.0 },
        'u1',
        key,
      );
      expect(again.id).toBe(first.id);
      expect(await repo.listByPlan('plan-1')).toHaveLength(1);
    });

    it('el mismo día como medianoche UTC (forma pre-DX-097) es la misma petición', async () => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan();
      const first = await uc.execute('plan-1', body, 'u1', key);
      const again = await uc.execute(
        'plan-1',
        { ...body, paidAt: '2026-03-05T00:00:00Z' },
        'u1',
        key,
      );
      expect(again.id).toBe(first.id);
      await expect(
        uc.execute(
          'plan-1',
          { ...body, paidAt: '2026-03-05T15:00:00Z' },
          'u1',
          key,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(await repo.listByPlan('plan-1')).toHaveLength(1);
    });

    it.each([
      ['otro importe', 'plan-1', { ...body, amount: 101 }],
      ['otra fecha', 'plan-1', { ...body, paidAt: '2026-03-06' }],
      ['otras notas', 'plan-1', { ...body, notes: 'corrección' }],
      ['otro plan', 'plan-2', body],
    ])('con %s es 422 y no crea nada', async (_label, planId, other) => {
      const { repo, fakeGetPlan, uc } = makeUseCase();
      fakeGetPlan.plan = makePlan();
      await uc.execute('plan-1', body, 'u1', key);
      fakeGetPlan.plan = makePlan({ id: planId });
      const attempt = uc.execute(planId, other, 'u1', key);
      await expect(attempt).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      await expect(attempt).rejects.toThrow(/clave de idempotencia/);
      expect(await repo.listByPlan('plan-2')).toHaveLength(0);
      expect(await repo.listByPlan('plan-1')).toHaveLength(1);
    });

    it('un abono anterior a DX-109 (sin huella) se sigue devolviendo si el plan coincide', async () => {
      const { repo, uc } = makeUseCase();
      const legacy = repo.seedPayment({
        treatmentPlanId: 'plan-1',
        idempotencyKey: key,
        requestFingerprint: null,
      });
      const replay = await uc.execute('plan-1', body, 'u1', key);
      expect(replay.id).toBe(legacy.id);
      await expect(
        uc.execute('plan-2', body, 'u1', key),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});
