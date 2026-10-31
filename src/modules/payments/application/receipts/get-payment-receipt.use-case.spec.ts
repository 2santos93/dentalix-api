import { NotFoundException } from '@nestjs/common';
import { GetPaymentReceiptUseCase } from './get-payment-receipt.use-case';
import type {
  PaymentReceiptRepository,
  PaymentReceiptSource,
} from '../../domain/ports/payment-receipt-repository.port';
import type { GetPlanBalanceUseCase } from '../use-cases/get-plan-balance.use-case';
import {
  buildReceiptSnapshot,
  type ReceiptSnapshot,
  type ReceiptSnapshotInput,
} from '../../domain/receipt-snapshot';
import {
  FixedDocumentTypeNamesReader,
  NO_LOCAL_NAMES,
} from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';

// DX-203: sin responsables; lo que decide el destinatario lo prueba
// send-payment-receipt.use-case.spec.ts.
const NOTICE = {
  patient: {
    firstName: 'Ana',
    birthDate: null,
    email: null,
    emergencyContactName: null,
  },
  responsibles: [],
  settings: { timeZone: 'America/Bogota', majorityAge: 18 },
};

const PAYMENT_ID = '3f1c2b9e-8a4d-4c1e-9f0a-1b2c3d4e5f60';

// DX-376: la tasa del abono tal como la guarda (DX-375). En la moneda del
// plan no hay tasa que imprimir.
const SAME_CURRENCY_RATE: PaymentReceiptSource['rate'] = {
  amount: 50000,
  currency: 'COP',
  exchangeRateCurrency: 'COP',
  frozenRate: null,
};

const snapshotInput: Omit<ReceiptSnapshotInput, 'planBalance'> = {
  clinic: { name: 'Clínica Demo', legalName: null, taxId: null, address: null },
  location: { id: 'loc-1', name: 'Sede Norte', address: null },
  patient: {
    id: 'pat-1',
    firstName: 'Ana',
    lastName: 'Ruiz',
    docType: 'NATIONAL_ID',
    docTypeLabel: null,
    docNumber: '52123456',
  },
  payment: {
    id: PAYMENT_ID,
    amount: 50000,
    currency: 'COP',
    method: 'CARD',
    paidAt: new Date('2025-01-10T17:00:00.000Z'),
    paidOn: '2025-01-10',
  },
  plan: { id: 'plan-1', optionLabel: null, createdAt: new Date('2025-01-02') },
  cashier: null,
};

const issuedSnapshot = buildReceiptSnapshot(
  {
    ...snapshotInput,
    planBalance: {
      currency: 'COP',
      billable: 100000,
      paid: 50000,
      balance: 50000,
    },
  },
  NO_LOCAL_NAMES,
);

let names: FixedDocumentTypeNamesReader;
beforeEach(() => {
  names = new FixedDocumentTypeNamesReader();
});

function makeUseCase(
  source: PaymentReceiptSource | null,
  balance: { billable: number; paid: number } | Error = {
    billable: 300000,
    paid: 120000,
  },
) {
  const repo: PaymentReceiptRepository = {
    findByPaymentId: () => Promise.resolve(source),
  };
  const getPlanBalance = {
    execute: () =>
      balance instanceof Error
        ? Promise.reject(balance)
        : Promise.resolve({
            planCurrency: 'COP',
            ...balance,
            balance: balance.billable - balance.paid,
            paymentsCount: 2,
          }),
  } as unknown as GetPlanBalanceUseCase;
  return new GetPaymentReceiptUseCase(repo, getPlanBalance, names);
}

const issued = (
  overrides: Partial<
    Extract<PaymentReceiptSource, { kind: 'issued' }>['receipt']
  > = {},
): PaymentReceiptSource => ({
  kind: 'issued',
  paymentId: PAYMENT_ID,
  treatmentPlanId: 'plan-1',
  patientEmail: 'ana@example.com',
  notice: NOTICE,
  rate: SAME_CURRENCY_RATE,
  splitRates: [],
  receipt: {
    seriesPrefix: 'NOR',
    number: 123,
    issuedAt: new Date('2026-10-17T15:00:00.000Z'),
    snapshot: issuedSnapshot,
    voidedAt: null,
    voidReason: null,
    ...overrides,
  },
});

describe('GetPaymentReceiptUseCase (DX-136)', () => {
  it('un recibo emitido sale con su número y SU foto, tal como se guardó', async () => {
    await expect(makeUseCase(issued()).execute(PAYMENT_ID)).resolves.toEqual({
      paymentId: PAYMENT_ID,
      reference: 'NOR-000123',
      seriesPrefix: 'NOR',
      number: 123,
      legacy: false,
      issuedAt: new Date('2026-10-17T15:00:00.000Z'),
      voided: false,
      voidedAt: null,
      voidReason: null,
      exchangeRate: null,
      split: null,
      snapshot: {
        ...issuedSnapshot,
        patient: {
          id: 'pat-1',
          fullName: 'Ana Ruiz',
          docType: 'NATIONAL_ID',
          docTypeLabel: null,
          docTypeName: 'Documento nacional',
          docNumberMasked: '****3456',
        },
      },
    });
    expect(names.reads).toBe(1);
  });

  it('legacy receipt snapshot with CC renders with the generic type, no label and the current local name', async () => {
    names.names.NATIONAL_ID = 'Documento A';
    const legacy = {
      ...issuedSnapshot,
      patient: {
        id: 'pat-1',
        fullName: 'Ana Ruiz',
        docType: 'CC',
        docNumberMasked: '****3456',
      },
    } satisfies ReceiptSnapshot;
    const view = await makeUseCase(issued({ snapshot: legacy })).execute(
      PAYMENT_ID,
    );
    expect(view.snapshot.patient).toEqual({
      id: 'pat-1',
      fullName: 'Ana Ruiz',
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docTypeName: 'Documento A',
      docNumberMasked: '****3456',
    });
  });

  it('un recibo anulado conserva el número y trae fecha y motivo', async () => {
    const voidedAt = new Date('2026-10-18T10:00:00.000Z');
    const view = await makeUseCase(
      issued({ voidedAt, voidReason: 'Cobro duplicado' }),
    ).execute(PAYMENT_ID);
    expect(view).toMatchObject({
      reference: 'NOR-000123',
      voided: true,
      voidedAt,
      voidReason: 'Cobro duplicado',
    });
  });

  it('el saldo que muestra es el de la foto, aunque el del plan haya cambiado', async () => {
    const view = await makeUseCase(issued(), {
      billable: 999999,
      paid: 1,
    }).execute(PAYMENT_ID);
    expect(view.snapshot.planBalance).toEqual({
      currency: 'COP',
      billable: 100000,
      paid: 50000,
      balance: 50000,
    });
  });

  it('un abono anterior a la numeración sale con REC-xxxx, «sin serie» y los datos de hoy', async () => {
    const view = await makeUseCase({
      kind: 'legacy',
      paymentId: PAYMENT_ID,
      treatmentPlanId: 'plan-1',
      patientEmail: null,
      notice: NOTICE,
      rate: SAME_CURRENCY_RATE,
      splitRates: [],
      legacy: {
        issuedAt: new Date('2025-01-10T17:05:00.000Z'),
        voidedAt: null,
        voidReason: null,
        snapshotInput,
      },
    }).execute(PAYMENT_ID);
    expect(view).toMatchObject({
      reference: 'REC-3f1c2b9e',
      seriesPrefix: null,
      number: null,
      legacy: true,
      voided: false,
    });
    expect(view.snapshot.patient.docNumberMasked).toBe('****3456');
    expect(view.snapshot.planBalance).toEqual({
      currency: 'COP',
      billable: 300000,
      paid: 120000,
      balance: 180000,
    });
  });

  it('un abono antiguo cuyo saldo no se puede calcular sale sin saldo', async () => {
    const view = await makeUseCase(
      {
        kind: 'legacy',
        paymentId: PAYMENT_ID,
        treatmentPlanId: 'plan-1',
        patientEmail: null,
        notice: NOTICE,
        rate: SAME_CURRENCY_RATE,
        splitRates: [],
        legacy: {
          issuedAt: new Date(),
          voidedAt: new Date('2025-02-01T12:00:00.000Z'),
          voidReason: 'Error de digitación',
          snapshotInput,
        },
      },
      new NotFoundException(),
    ).execute(PAYMENT_ID);
    expect(view.snapshot.planBalance).toBeNull();
    expect(view.voided).toBe(true);
  });

  describe('DX-376: la tasa congelada del abono', () => {
    const FROZEN = {
      currency: 'USD',
      fromPerBase: 36.5,
      toPerBase: 1,
      source: 'MANUAL' as const,
      date: '2026-10-30',
    };
    const inVes = (frozenRate: typeof FROZEN | null): PaymentReceiptSource => ({
      ...issued(),
      rate: {
        amount: 1825,
        currency: 'VES',
        exchangeRateCurrency: 'USD',
        frozenRate,
      },
    });

    it('un abono en otra moneda trae la tasa congelada, su fuente, su día y el equivalente en la moneda del plan', async () => {
      const view = await makeUseCase(inVes(FROZEN)).execute(PAYMENT_ID);
      expect(view.exchangeRate).toEqual({
        status: 'FROZEN',
        rate: FROZEN,
        equivalentAmount: 50,
      });
    });

    it('la reimpresión usa la tasa congelada aunque la del día cambie: no convierte en vivo', async () => {
      // La foto y la tasa congelada no dependen del saldo ni de la tasa de hoy.
      const first = await makeUseCase(inVes(FROZEN)).execute(PAYMENT_ID);
      const again = await makeUseCase(inVes(FROZEN), {
        billable: 1,
        paid: 999,
      }).execute(PAYMENT_ID);
      expect(again.exchangeRate).toEqual(first.exchangeRate);
    });

    it('un abono «sin tasa» lo dice, sin tasa ni equivalente', async () => {
      const view = await makeUseCase(inVes(null)).execute(PAYMENT_ID);
      expect(view.exchangeRate).toEqual({
        status: 'MISSING',
        rate: null,
        equivalentAmount: null,
      });
    });

    it('un abono en la moneda del plan no trae tasa', async () => {
      const view = await makeUseCase(issued()).execute(PAYMENT_ID);
      expect(view.exchangeRate).toBeNull();
    });
  });

  describe('DX-390: el recibo único de un cobro dividido', () => {
    const FROZEN = {
      currency: 'COP',
      fromPerBase: 1,
      toPerBase: 4000,
      source: 'AUTOMATIC' as const,
      date: '2026-10-30',
    };
    const line = (n: number, amount: number, currency: string) => ({
      paymentId: `line-${n}`,
      line: n,
      amount,
      currency,
      method: n === 1 ? ('TRANSFER' as const) : ('CASH' as const),
      paymentMethodName: n === 1 ? 'Transferencia' : 'Efectivo',
      reference: n === 1 ? 'TR-1' : null,
      // La línea en USD se emitió «sin tasa».
      equivalentAmount: currency === 'COP' ? amount : null,
    });
    const splitSnapshot = buildReceiptSnapshot(
      {
        ...snapshotInput,
        planBalance: null,
        split: {
          lines: [line(1, 50, 'USD'), line(2, 100000, 'COP')],
          planCurrency: 'COP',
        },
      },
      NO_LOCAL_NAMES,
    );
    const source = (usdRate: typeof FROZEN | null): PaymentReceiptSource => ({
      ...issued({ snapshot: splitSnapshot }),
      paymentId: 'line-1',
      splitRates: [
        {
          paymentId: 'line-1',
          amount: 50,
          currency: 'USD',
          exchangeRateCurrency: 'COP',
          frozenRate: usdRate,
        },
        {
          paymentId: 'line-2',
          amount: 100000,
          currency: 'COP',
          exchangeRateCurrency: 'COP',
          frozenRate: null,
        },
      ],
    });

    it('la foto guarda las líneas y el total al emitir (null si alguna estaba sin tasa)', () => {
      expect(splitSnapshot.split?.lines).toHaveLength(2);
      expect(splitSnapshot.split?.total).toEqual({
        currency: 'COP',
        amount: null,
      });
    });

    it('sale con todas las líneas, la tasa congelada de hoy de cada una y el total en la moneda del plan', async () => {
      const view = await makeUseCase(source(FROZEN)).execute('line-2');
      expect(view.exchangeRate).toBeNull();
      expect(view.split?.lines.map((l) => l.equivalentAmount)).toEqual([
        200000, 100000,
      ]);
      expect(view.split?.lines[0].exchangeRate).toMatchObject({
        status: 'FROZEN',
        equivalentAmount: 200000,
      });
      expect(view.split?.total).toEqual({ currency: 'COP', amount: 300000 });
    });

    it('mientras una línea siga sin tasa, el total es null', async () => {
      const view = await makeUseCase(source(null)).execute('line-1');
      expect(view.split?.lines[0].exchangeRate?.status).toBe('MISSING');
      expect(view.split?.total.amount).toBeNull();
    });
  });

  it('un abono que no existe (o de otra clínica) es 404 en español', async () => {
    await expect(makeUseCase(null).execute(PAYMENT_ID)).rejects.toThrow(
      new NotFoundException('No encontramos ese abono.'),
    );
  });
});
