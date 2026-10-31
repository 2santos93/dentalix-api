import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { PaymentMethodGate } from '../payment-method-gate';
import type { PaymentMethodRepository } from '../../../payment-methods/domain/ports/payment-method-repository.port';
import type { ClinicPaymentMethodEntity } from '../../../payment-methods/domain/payment-method.entity';
import { MissingExchangeRateError } from '../../../exchange/domain/missing-exchange-rate.error';
import type { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import type { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import type { TreatmentPlanDetail } from '../../../treatment-plans/domain/entities/treatment-plan.entity';
import { PLAN_WITHOUT_OPTIONS } from '../../../treatment-plans/application/use-cases/__fixtures__/in-memory-treatment-plan.repository';
import type { ReceiptPlanBalanceCalculator } from '../receipts/receipt-plan-balance';
import type { GetPlanBalanceUseCase } from './get-plan-balance.use-case';
import { RecordPaymentUseCase } from './record-payment.use-case';
import {
  RecordSplitPaymentUseCase,
  type RecordSplitPaymentInput,
} from './record-split-payment.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import {
  SPLIT_LINE_METHOD_REQUIRED_MESSAGE,
  SPLIT_LINES_COUNT_MESSAGE,
  SPLIT_LINES_SAME_REFERENCE_MESSAGE,
  SPLIT_PAYMENT_EXCEEDS_BALANCE,
} from '../../domain/split-payment';
import { IDEMPOTENCY_KEY_REUSED_MESSAGE } from '../../domain/idempotency';

const KEY = '7b0a3f1e-9a51-4d1f-8f63-1c2d3e4f5a6b';

function medium(
  overrides: Partial<ClinicPaymentMethodEntity>,
): ClinicPaymentMethodEntity {
  return {
    id: 'm-cash',
    tenantId: 't1',
    name: 'Efectivo',
    kind: 'CASH',
    active: true,
    requiresReference: false,
    legacyMethod: 'CASH',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const MEDIUMS = [
  medium({}),
  medium({
    id: 'm-transfer',
    name: 'Transferencia',
    kind: 'TRANSFER',
    legacyMethod: 'TRANSFER',
    requiresReference: true,
  }),
  medium({
    id: 'm-mobile',
    name: 'Pago móvil',
    kind: 'DIGITAL',
    legacyMethod: null,
    requiresReference: true,
  }),
  medium({ id: 'm-off', name: 'Cheque', kind: 'OTHER', active: false }),
];

function makePlan(
  overrides: Partial<TreatmentPlanDetail> = {},
): TreatmentPlanDetail {
  return {
    id: 'plan-1',
    tenantId: 't1',
    patientId: 'patient-1',
    status: TreatmentPlanStatus.ACCEPTED,
    currency: 'COP',
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

/** Cotización de prueba (DX-375): unidades por 1 USD. */
class FakeConvertAmount {
  public perBase: Record<string, number> = { COP: 4000 };
  execute(): Promise<never> {
    return Promise.reject(new Error('no debe convertir en vivo'));
  }
  quote(input: { from: string; to: string; date: string }) {
    const rate = (c: string) => (c === 'USD' ? 1 : this.perBase[c]);
    if (rate(input.from) === undefined || rate(input.to) === undefined) {
      return Promise.reject(
        new MissingExchangeRateError(input.from, input.date),
      );
    }
    return Promise.resolve({
      ...input,
      source: 'AUTOMATIC' as const,
      fromPerBase: rate(input.from),
      toPerBase: rate(input.to),
    });
  }
}

function makeUseCase() {
  const repo = new InMemoryPaymentRepository();
  let plan: TreatmentPlanDetail | null = makePlan();
  const getPlan = {
    execute: () =>
      plan
        ? Promise.resolve(plan)
        : Promise.reject(new NotFoundException('Treatment plan not found')),
  };
  const convert = new FakeConvertAmount();
  const balance = { billable: 500_000, paid: 100_000 };
  const getPlanBalance = {
    execute: () =>
      Promise.resolve({
        planCurrency: 'COP',
        billable: balance.billable,
        paid: balance.paid,
        balance: balance.billable - balance.paid,
        paymentsCount: 1,
        paymentsWithoutRate: [],
      }),
  };
  const methods = {
    findById: (id: string) =>
      Promise.resolve(MEDIUMS.find((m) => m.id === id) ?? null),
    findByLegacyMethod: () => Promise.resolve(null),
  } as unknown as PaymentMethodRepository;
  const gate = new PaymentMethodGate(methods, repo);
  const recordPayment = new RecordPaymentUseCase(
    repo,
    getPlan as unknown as GetTreatmentPlanUseCase,
    { has: (code: string) => Promise.resolve(['USD', 'COP'].includes(code)) },
    {
      afterPayment: () => Promise.resolve(null),
    } as unknown as ReceiptPlanBalanceCalculator,
    convert as unknown as ConvertAmountUseCase,
    gate,
  );
  const uc = new RecordSplitPaymentUseCase(
    repo,
    getPlan as unknown as GetTreatmentPlanUseCase,
    recordPayment,
    getPlanBalance as unknown as GetPlanBalanceUseCase,
  );
  return {
    repo,
    uc,
    convert,
    balance,
    recordPayment,
    setPlan: (p: TreatmentPlanDetail | null) => {
      plan = p;
    },
  };
}

/** 50 USD por transferencia + 100 000 COP en efectivo, el 30/10/2026. */
function twoLines(
  overrides: Partial<RecordSplitPaymentInput> = {},
): RecordSplitPaymentInput {
  return {
    paidAt: '2026-10-30',
    lines: [
      {
        amount: 50,
        currency: 'usd',
        paymentMethodId: 'm-transfer',
        reference: 'TR-001',
      },
      { amount: 100_000, currency: 'COP', paymentMethodId: 'm-cash' },
    ],
    ...overrides,
  };
}

describe('RecordSplitPaymentUseCase (DX-390)', () => {
  it('registra un abono por línea en UNA llamada al repositorio, con su tasa, su base y el total en la moneda del plan', async () => {
    const { uc, repo } = makeUseCase();

    const result = await uc.execute('plan-1', twoLines(), 'user-1', KEY);

    expect(result.planCurrency).toBe('COP');
    // 50 USD × 4000 + 100 000 COP.
    expect(result.total).toBe(300_000);
    expect(result.payments).toHaveLength(2);
    expect(result.id).toBe(result.payments[0].id);
    expect(result.payments.map((p) => [p.splitId, p.splitLine])).toEqual([
      [result.id, 1],
      [result.id, 2],
    ]);
    const input = repo.lastSplitInput;
    expect(input?.idempotencyKey).toBe(KEY);
    expect(input?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      input?.lines.map((l) => [l.currency, l.method, l.reference]),
    ).toEqual([
      ['USD', 'TRANSFER', 'TR-001'],
      ['COP', 'CASH', null],
    ]);
    expect(input?.lines[0].frozenRate).toMatchObject({
      currency: 'COP',
      fromPerBase: 1,
      toPerBase: 4000,
    });
    expect(input?.lines[0].planAmount).toEqual({
      planCurrency: 'COP',
      amount: 200_000,
      rateDate: '2026-10-30',
    });
    // Saldo del recibo: 500 000 − (100 000 + 300 000).
    expect(input?.receiptPlanBalance).toEqual({
      currency: 'COP',
      billable: 500_000,
      paid: 400_000,
      balance: 100_000,
    });
  });

  it('una línea sin tasa de su día: el cobro se registra, la línea queda sin base y el total y el saldo del recibo en null', async () => {
    const { uc, repo, convert } = makeUseCase();
    convert.perBase = {};

    const result = await uc.execute('plan-1', twoLines(), 'user-1');

    expect(result.total).toBeNull();
    expect(repo.lastSplitInput?.lines[0].frozenRate).toBeNull();
    expect(repo.lastSplitInput?.lines[0].planAmount).toBeNull();
    expect(repo.lastSplitInput?.receiptPlanBalance).toBeNull();
  });

  it.each([
    ['una sola línea', 1],
    ['seis líneas', 6],
  ])('%s → 400', async (_label, count) => {
    const { uc, repo } = makeUseCase();
    const line = { amount: 1000, currency: 'COP', paymentMethodId: 'm-cash' };
    await expect(
      uc.execute('plan-1', {
        paidAt: '2026-10-30',
        lines: Array.from({ length: count }, () => line),
      }),
    ).rejects.toThrow(new BadRequestException(SPLIT_LINES_COUNT_MESSAGE));
    expect(repo.lastSplitInput).toBeNull();
  });

  it('una línea sin medio → 400 en español', async () => {
    const { uc } = makeUseCase();
    const input = twoLines();
    input.lines[1].paymentMethodId = '';
    await expect(uc.execute('plan-1', input)).rejects.toThrow(
      SPLIT_LINE_METHOD_REQUIRED_MESSAGE,
    );
  });

  it('cada línea respeta su medio: sin la referencia que pide, desactivado o ajeno → 400 y no se registra nada', async () => {
    const { uc, repo } = makeUseCase();
    const noReference = twoLines();
    delete noReference.lines[0].reference;
    await expect(uc.execute('plan-1', noReference)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const inactive = twoLines();
    inactive.lines[1].paymentMethodId = 'm-off';
    await expect(uc.execute('plan-1', inactive)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const foreign = twoLines();
    foreign.lines[1].paymentMethodId = 'm-otra-clinica';
    await expect(uc.execute('plan-1', foreign)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.lastSplitInput).toBeNull();
  });

  it('la referencia repetida de una línea → 409 con su `line`; con su motivo se registra', async () => {
    const { uc, repo } = makeUseCase();
    repo.seedPayment({
      paymentMethodId: 'm-mobile',
      referenceNormalized: 'PM777',
      paidAt: new Date('2026-10-20T17:00:00.000Z'),
    });
    const input = twoLines();
    input.lines[1] = {
      amount: 50_000,
      currency: 'COP',
      paymentMethodId: 'm-mobile',
      reference: 'PM-777',
    };

    const error = await uc
      .execute('plan-1', input, 'user-1', KEY)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'PAYMENT_REFERENCE_DUPLICATE',
      line: 1,
    });
    expect(repo.lastSplitInput).toBeNull();

    input.lines[1].duplicateReferenceReason = 'El banco lo devolvió y repitió';
    const result = await uc.execute('plan-1', input, 'user-1', KEY);
    expect(result.payments[1].duplicateReferenceReason).toBe(
      'El banco lo devolvió y repitió',
    );
    expect(result.payments[1].duplicateReferenceOf).toHaveLength(1);
    expect(result.payments[0].duplicateReferenceOf).toEqual([]);
  });

  it('dos líneas con el mismo medio y la misma referencia (normalizada) → 400', async () => {
    const { uc } = makeUseCase();
    const input = twoLines();
    input.lines[1] = {
      amount: 10_000,
      currency: 'COP',
      paymentMethodId: 'm-transfer',
      reference: 'tr 001',
    };
    await expect(uc.execute('plan-1', input)).rejects.toThrow(
      SPLIT_LINES_SAME_REFERENCE_MESSAGE,
    );
  });

  it('el total supera lo pendiente → 409 SPLIT_PAYMENT_EXCEEDS_BALANCE con las cifras; confirmado, se registra con saldo a favor', async () => {
    const { uc, repo, balance } = makeUseCase();
    balance.paid = 300_000; // pendiente 200 000; el cobro suma 300 000

    const error = await uc
      .execute('plan-1', twoLines())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: SPLIT_PAYMENT_EXCEEDS_BALANCE,
      currency: 'COP',
      total: 300_000,
      pending: 200_000,
      excess: 100_000,
    });
    expect(repo.lastSplitInput).toBeNull();

    const result = await uc.execute(
      'plan-1',
      twoLines({ confirmCreditBalance: true }),
    );
    expect(result.total).toBe(300_000);
    expect(repo.lastSplitInput?.receiptPlanBalance?.balance).toBe(-100_000);
  });

  // QA DX-390 (B2): con saldo a favor previo, lo pendiente es 0 (no negativo)
  // y el excedente es solo lo que ESTE cobro supera lo pendiente.
  it('con saldo a favor previo, el 409 da pendiente 0 y el excedente es el total del cobro', async () => {
    const { uc, balance } = makeUseCase();
    balance.paid = 515_000; // saldo a favor previo de 15 000

    const error = await uc
      .execute('plan-1', twoLines())
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: SPLIT_PAYMENT_EXCEEDS_BALANCE,
      total: 300_000,
      pending: 0,
      excess: 300_000,
    });
  });

  it('justo lo pendiente no pide confirmación', async () => {
    const { uc, balance } = makeUseCase();
    balance.paid = 200_000; // pendiente 300 000 = el cobro
    await expect(uc.execute('plan-1', twoLines())).resolves.toMatchObject({
      total: 300_000,
    });
  });

  // Revisión DX-390: lo pendiente se lee fuera de la transacción; sin la
  // confirmación, el repositorio comprueba dentro (con el plan bloqueado) que
  // ningún abono llegó al plan desde esa lectura.
  it('sin confirmar, pasa al repositorio cuántos abonos tenía el plan ANTES de leer lo pendiente; confirmado, no', async () => {
    const { uc, repo } = makeUseCase();
    await uc.execute('plan-1', twoLines());
    const seen = repo.lastSplitInput?.balanceGuard?.planPaymentsSeen;
    expect(seen).toEqual(expect.any(Number));

    // Cuenta también los anulados (solo crece).
    repo.seedPayment({ treatmentPlanId: 'plan-1' });
    repo.seedPayment({ treatmentPlanId: 'plan-1', deletedAt: new Date() });
    await uc.execute(
      'plan-1',
      twoLines({
        lines: twoLines().lines.map((l, i) =>
          i === 0 ? { ...l, reference: 'TR-002' } : l,
        ),
      }),
    );
    expect(repo.lastSplitInput?.balanceGuard?.planPaymentsSeen).toBe(
      (seen ?? 0) + 4,
    );

    await uc.execute(
      'plan-1',
      twoLines({
        confirmCreditBalance: true,
        lines: twoLines().lines.map((l, i) =>
          i === 0 ? { ...l, reference: 'TR-003' } : l,
        ),
      }),
    );
    expect(repo.lastSplitInput?.balanceGuard).toBeUndefined();
  });

  it('un plan rechazado o cancelado → 409; uno de otra clínica → 404', async () => {
    const { uc, setPlan } = makeUseCase();
    setPlan(makePlan({ status: TreatmentPlanStatus.CANCELLED }));
    await expect(uc.execute('plan-1', twoLines())).rejects.toBeInstanceOf(
      ConflictException,
    );
    setPlan(null);
    await expect(uc.execute('plan-1', twoLines())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('Idempotency-Key', () => {
    it('repetir el mismo cobro con la misma clave devuelve el original sin registrar otro', async () => {
      const { uc, repo } = makeUseCase();
      const first = await uc.execute('plan-1', twoLines(), 'user-1', KEY);
      repo.lastSplitInput = null;

      const again = await uc.execute('plan-1', twoLines(), 'user-1', KEY);

      expect(repo.lastSplitInput).toBeNull();
      expect(again.id).toBe(first.id);
      expect(again.payments.map((p) => p.id)).toEqual(
        first.payments.map((p) => p.id),
      );
      expect(again.total).toBe(300_000);
    });

    it('el reintento tras el 409 del saldo a favor (con la confirmación) es la misma petición', async () => {
      const { uc } = makeUseCase();
      const first = await uc.execute(
        'plan-1',
        twoLines({ confirmCreditBalance: true }),
        'user-1',
        KEY,
      );
      const again = await uc.execute('plan-1', twoLines(), 'user-1', KEY);
      expect(again.id).toBe(first.id);
    });

    it('la misma clave con otro cuerpo, otro plan o la de un abono suelto → 422', async () => {
      const { uc, recordPayment } = makeUseCase();
      await uc.execute('plan-1', twoLines(), 'user-1', KEY);
      const other = twoLines();
      other.lines[1].amount = 99_000;
      await expect(uc.execute('plan-1', other, 'user-1', KEY)).rejects.toThrow(
        new UnprocessableEntityException(IDEMPOTENCY_KEY_REUSED_MESSAGE),
      );
      await expect(
        uc.execute('plan-2', twoLines(), 'user-1', KEY),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      // El abono suelto con la clave del cobro tampoco cobra otra vez.
      await expect(
        recordPayment.execute(
          'plan-1',
          { amount: 50, currency: 'USD', paidAt: '2026-10-30' },
          'user-1',
          KEY,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      const singleKey = 'aa0a3f1e-9a51-4d1f-8f63-1c2d3e4f5a6b';
      await recordPayment.execute(
        'plan-1',
        { amount: 1000, currency: 'COP', paidAt: '2026-10-30' },
        'user-1',
        singleKey,
      );
      await expect(
        uc.execute('plan-1', twoLines(), 'user-1', singleKey),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('una clave que no es UUID → 400', async () => {
      const { uc } = makeUseCase();
      await expect(
        uc.execute('plan-1', twoLines(), 'user-1', 'no-es-uuid'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
