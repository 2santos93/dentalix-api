import { referenceCurrencyDigitsCatalog } from '../../../shared/money/__fixtures__/reference-currency-digits';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import { InMemoryPaymentRepository } from './use-cases/__fixtures__/in-memory-payment.repository';
import { PaymentMethodGate } from './payment-method-gate';
import type { ClinicPaymentMethodEntity } from '../../payment-methods/domain/payment-method.entity';
import type { PaymentMethodRepository } from '../../payment-methods/domain/ports/payment-method-repository.port';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function method(
  overrides: Partial<ClinicPaymentMethodEntity>,
): ClinicPaymentMethodEntity {
  return {
    id: 'pm-x',
    tenantId: 't1',
    name: 'Medio',
    kind: 'OTHER',
    active: true,
    requiresReference: false,
    adjustments: [],
    legacyMethod: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const MOBILE = method({
  id: 'pm-mobile',
  name: 'Pago móvil',
  kind: 'DIGITAL',
  requiresReference: true,
});
const CASH = method({
  id: 'pm-cash',
  name: 'Efectivo',
  kind: 'CASH',
  legacyMethod: 'CASH',
});
const OFF = method({ id: 'pm-off', active: false });

function methodsRepo(
  rows: ClinicPaymentMethodEntity[],
): Pick<PaymentMethodRepository, 'findById' | 'findByLegacyMethod'> {
  return {
    findById: (id: string) =>
      Promise.resolve(rows.find((r) => r.id === id) ?? null),
    findByLegacyMethod: (legacy: PaymentMethod) =>
      Promise.resolve(rows.find((r) => r.legacyMethod === legacy) ?? null),
  };
}

describe('PaymentMethodGate (DX-377)', () => {
  let payments: InMemoryPaymentRepository;
  let gate: PaymentMethodGate;
  const paidAt = new Date('2026-06-01T15:00:00.000Z');

  beforeEach(() => {
    payments = new InMemoryPaymentRepository();
    gate = new PaymentMethodGate(
      methodsRepo([MOBILE, CASH, OFF]) as PaymentMethodRepository,
      payments,
      referenceCurrencyDigitsCatalog(),
    );
  });

  it('deriva el método antiguo del tipo base (DIGITAL → TRANSFER)', async () => {
    const out = await gate.resolve(
      { paymentMethodId: 'pm-mobile', reference: ' 01 23 ab ' },
      paidAt,
    );
    expect(out).toMatchObject({
      paymentMethodId: 'pm-mobile',
      method: 'TRANSFER',
      reference: '01 23 ab',
      referenceNormalized: '0123AB',
      duplicateReferenceReason: null,
      duplicateReferenceOf: [],
    });
  });

  it('400 en español sin referencia si el medio la pide', async () => {
    await expect(
      gate.resolve({ paymentMethodId: 'pm-mobile' }, paidAt),
    ).rejects.toThrow(
      new BadRequestException(
        'Este medio de pago pide la referencia del pago.',
      ),
    );
  });

  it('400 con un medio desactivado o ajeno', async () => {
    await expect(
      gate.resolve({ paymentMethodId: 'pm-off' }, paidAt),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      gate.resolve({ paymentMethodId: 'pm-otra-clinica' }, paidAt),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('solo `method` (cliente anterior): se enlaza al medio inicial', async () => {
    const out = await gate.resolve({ method: 'CASH' }, paidAt);
    expect(out).toMatchObject({ paymentMethodId: 'pm-cash', method: 'CASH' });
  });

  it('409 con código estable si la referencia ya se usó con ese medio en 90 días', async () => {
    payments.seedPayment({
      id: 'prev',
      paymentMethodId: 'pm-mobile',
      referenceNormalized: '0123AB',
      paidAt: new Date('2026-03-10T12:00:00.000Z'),
    });
    const error = await gate
      .resolve({ paymentMethodId: 'pm-mobile', reference: '0123ab' }, paidAt)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_REFERENCE_DUPLICATE',
      matches: [expect.objectContaining({ id: 'prev' })],
    });
  });

  it('con motivo se confirma y devuelve los repetidos', async () => {
    payments.seedPayment({
      id: 'prev',
      paymentMethodId: 'pm-mobile',
      referenceNormalized: '0123AB',
      paidAt: new Date('2026-05-30T12:00:00.000Z'),
    });
    const out = await gate.resolve(
      {
        paymentMethodId: 'pm-mobile',
        reference: '0123AB',
        duplicateReferenceReason: '  Mismo pago en dos cuotas ',
      },
      paidAt,
    );
    expect(out.duplicateReferenceReason).toBe('Mismo pago en dos cuotas');
    expect(out.duplicateReferenceOf).toEqual(['prev']);
  });

  it('fuera de la ventana, anulado o con otro medio no avisa', async () => {
    payments.seedPayment({
      paymentMethodId: 'pm-mobile',
      referenceNormalized: '0123AB',
      paidAt: new Date('2026-02-01T12:00:00.000Z'),
    });
    payments.seedPayment({
      paymentMethodId: 'pm-mobile',
      referenceNormalized: '0123AB',
      paidAt,
      deletedAt: NOW,
    });
    payments.seedPayment({
      paymentMethodId: 'pm-cash',
      referenceNormalized: '0123AB',
      paidAt,
    });
    const out = await gate.resolve(
      {
        paymentMethodId: 'pm-mobile',
        reference: '0123AB',
        duplicateReferenceReason: 'sobra',
      },
      paidAt,
    );
    expect(out.duplicateReferenceOf).toEqual([]);
    // Sin repetida, el motivo no se guarda.
    expect(out.duplicateReferenceReason).toBeNull();
  });
});

describe('PaymentMethodGate: ajustes del medio (DX-516)', () => {
  const adjustment = (
    overrides: Partial<ClinicPaymentMethodEntity['adjustments'][number]>,
  ): ClinicPaymentMethodEntity['adjustments'][number] => ({
    id: 'adj-1',
    paymentMethodId: 'pm-card',
    type: 'TAX',
    label: 'Impuesto',
    calculation: 'PERCENT',
    percent: 3,
    fixedAmount: null,
    fixedCurrency: null,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  const CARD = method({
    id: 'pm-card',
    kind: 'CARD',
    legacyMethod: 'CARD',
    adjustments: [
      adjustment({}),
      adjustment({ id: 'adj-off', label: 'Apagado', active: false }),
      adjustment({
        id: 'adj-fixed',
        type: 'DISCOUNT',
        label: 'Fijo',
        calculation: 'FIXED',
        percent: null,
        fixedAmount: 1,
        fixedCurrency: 'USD',
      }),
    ],
  });
  const gate = new PaymentMethodGate(
    methodsRepo([CARD]) as PaymentMethodRepository,
    new InMemoryPaymentRepository(),
    referenceCurrencyDigitsCatalog(),
  );
  const paidAt = new Date('2026-06-01T15:00:00.000Z');

  it('calcula los activos del medio sobre el importe y la moneda del abono', async () => {
    const out = await gate.resolve({ paymentMethodId: 'pm-card' }, paidAt, {
      amount: 100,
      currency: 'USD',
    });
    expect(
      out.adjustments.map((a) => [a.sourceAdjustmentId, a.type, a.amount]),
    ).toEqual([
      ['adj-1', 'TAX', 3],
      ['adj-fixed', 'DISCOUNT', 1],
    ]);
  });

  it('el fijo en otra moneda no se aplica; sin importe, ningún ajuste', async () => {
    const eur = await gate.resolve({ paymentMethodId: 'pm-card' }, paidAt, {
      amount: 100,
      currency: 'EUR',
    });
    expect(eur.adjustments.map((a) => a.sourceAdjustmentId)).toEqual(['adj-1']);
    const none = await gate.resolve({ paymentMethodId: 'pm-card' }, paidAt);
    expect(none.adjustments).toEqual([]);
  });

  it('un cliente anterior que solo manda `method` usa los ajustes de su medio inicial', async () => {
    const out = await gate.resolve({ method: 'CARD' }, paidAt, {
      amount: 10,
      currency: 'USD',
    });
    expect(out.adjustments.map((a) => a.amount)).toEqual([0.3, 1]);
  });
});
