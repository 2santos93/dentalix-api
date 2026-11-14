import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  GetPaymentReceiptSummaryUseCase,
  RECEIPT_SUMMARY_PATIENT_NOT_FOUND_MESSAGE,
} from './get-payment-receipt-summary.use-case';
import type {
  PaymentReceiptSummaryRepository,
  ReceiptSummaryQuery,
  ReceiptSummarySource,
} from '../../domain/ports/payment-receipt-summary-repository.port';
import {
  RECEIPT_SUMMARY_INVALID_PERIOD_MESSAGE,
  RECEIPT_SUMMARY_NOTICE,
  RECEIPT_SUMMARY_PERIOD_TOO_LONG_MESSAGE,
} from '../../domain/receipt-summary';
import { PERIOD_DAY_OUT_OF_RANGE_MESSAGE } from '../../../../shared/time/civil-day';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { DocumentTypeNamesReader } from '../../../patients/domain/ports/document-type-names-repository.port';

const NOW = new Date('2026-11-05T14:00:00.000Z');
const PATIENT_ID = '7d9a3b52-1c4e-4f8a-9b7d-2e6f1a0c5d31';

const source: ReceiptSummarySource = {
  patient: {
    id: PATIENT_ID,
    firstName: ' María Fernanda ',
    lastName: 'Rondón',
    documentType: 'NATIONAL_ID',
    docTypeLabel: null,
    docNumber: 'V12345678',
    patientCode: 1042,
  },
  clinic: {
    name: 'Clínica Ávila',
    legalName: 'Odontología Ávila C.A.',
    taxId: 'J-12345678-9',
    taxIdLabel: 'RIF',
    address: '  ',
  },
  items: [
    {
      paymentId: 'pay-2',
      locationId: 'loc-2',
      receiptNumber: 'ALT-000004',
      issuedAt: new Date('2026-10-20T15:00:00.000Z'),
      issuedOn: '2026-10-20',
      locationName: 'Sede Altamira',
      voided: false,
      voidReason: null,
      parts: [
        {
          amount: 1800,
          currency: 'VES',
          method: 'TRANSFER',
          paymentMethodName: 'Pago móvil',
        },
      ],
    },
    {
      paymentId: 'pay-1',
      locationId: 'loc-1',
      receiptNumber: 'CCS-000010',
      issuedAt: new Date('2026-10-02T15:00:00.000Z'),
      issuedOn: '2026-10-02',
      locationName: 'Sede Chacao',
      voided: true,
      voidReason: 'Cobro duplicado',
      parts: [
        {
          amount: 40,
          currency: 'USD',
          method: 'CASH',
          paymentMethodName: null,
        },
      ],
    },
  ],
};

function makeUseCase(found: ReceiptSummarySource | null = source) {
  const queries: ReceiptSummaryQuery[] = [];
  const repo: PaymentReceiptSummaryRepository = {
    find: (query) => {
      queries.push(query);
      return Promise.resolve(found);
    },
    recipient: () => Promise.reject(new Error('no se usa')),
  };
  const names = {
    get: () => Promise.resolve({ NATIONAL_ID: 'Cédula' }),
  } as unknown as DocumentTypeNamesReader;
  const tenantContext = new TenantContextService();
  const uc = new GetPaymentReceiptSummaryUseCase(
    repo,
    names,
    tenantContext,
    () => NOW,
  );
  return { uc, queries, tenantContext };
}

describe('GetPaymentReceiptSummaryUseCase (DX-401)', () => {
  it('arma la vista: paciente de hoy enmascarado, clínica, filas y totales por moneda', async () => {
    const { uc, queries, tenantContext } = makeUseCase();
    const view = await tenantContext.run('t-1', undefined, () =>
      uc.execute(PATIENT_ID, { from: '2026-10-01', to: '2026-10-31' }),
    );
    expect(queries).toEqual([
      {
        patientId: PATIENT_ID,
        from: '2026-10-01',
        to: '2026-10-31',
        locationIds: undefined,
      },
    ]);
    expect(view).toEqual({
      patient: {
        id: PATIENT_ID,
        fullName: 'María Fernanda Rondón',
        documentMasked: '*****5678',
        documentTypeName: 'Cédula',
        patientCode: '1042',
      },
      clinic: {
        name: 'Clínica Ávila',
        legalName: 'Odontología Ávila C.A.',
        taxId: 'J-12345678-9',
        taxIdLabel: 'RIF',
        address: null,
      },
      from: '2026-10-01',
      to: '2026-10-31',
      generatedAt: NOW.toISOString(),
      restrictedToLocations: false,
      receipts: [
        {
          paymentId: 'pay-1',
          receiptNumber: 'CCS-000010',
          issuedOn: '2026-10-02',
          locationName: 'Sede Chacao',
          methodLabel: 'Efectivo',
          amount: 40,
          currency: 'USD',
          voided: true,
          voidReason: 'Cobro duplicado',
        },
        {
          paymentId: 'pay-2',
          receiptNumber: 'ALT-000004',
          issuedOn: '2026-10-20',
          locationName: 'Sede Altamira',
          methodLabel: 'Pago móvil',
          amount: 1800,
          currency: 'VES',
          voided: false,
          voidReason: null,
        },
      ],
      totals: [{ currency: 'VES', amount: 1800, count: 1 }],
      voidedCount: 1,
      notice: RECEIPT_SUMMARY_NOTICE,
    });
    expect(JSON.stringify(view)).not.toContain('V12345678');
  });

  it('DX-525: un miembro restringido pide solo sus sedes y la vista lo dice', async () => {
    const { uc, queries, tenantContext } = makeUseCase({
      ...source,
      items: [],
    });
    const view = await tenantContext.run(
      't-1',
      undefined,
      () => uc.execute(PATIENT_ID, { from: '2026-10-01', to: '2026-10-31' }),
      ['loc-1'],
    );
    expect(queries[0].locationIds).toEqual(['loc-1']);
    expect(view.restrictedToLocations).toBe(true);
    expect(view.receipts).toEqual([]);
    expect(view.totals).toEqual([]);
    expect(view.voidedCount).toBe(0);
  });

  it('paciente inexistente o de otra clínica: 404 en español', async () => {
    const { uc, tenantContext } = makeUseCase(null);
    const run = tenantContext.run('t-1', undefined, () =>
      uc.execute(PATIENT_ID, { from: '2026-10-01', to: '2026-10-01' }),
    );
    await expect(run).rejects.toBeInstanceOf(NotFoundException);
    await expect(run).rejects.toThrow(
      RECEIPT_SUMMARY_PATIENT_NOT_FOUND_MESSAGE,
    );
  });

  it.each([
    [
      'día inexistente',
      '2026-02-30',
      '2026-03-01',
      RECEIPT_SUMMARY_INVALID_PERIOD_MESSAGE,
    ],
    [
      'desde > hasta',
      '2026-10-31',
      '2026-10-01',
      RECEIPT_SUMMARY_INVALID_PERIOD_MESSAGE,
    ],
    [
      'forma inválida',
      '01/10/2026',
      '2026-10-31',
      RECEIPT_SUMMARY_INVALID_PERIOD_MESSAGE,
    ],
    [
      'más de 366 días',
      '2025-01-01',
      '2026-01-02',
      RECEIPT_SUMMARY_PERIOD_TOO_LONG_MESSAGE,
    ],
    [
      'fuera del rango admitido',
      '1999-12-31',
      '2000-01-05',
      PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
    ],
  ])(
    'período inválido (%s): 400 en español sin leer nada',
    async (_, from, to, message) => {
      const { uc, queries, tenantContext } = makeUseCase();
      const run = tenantContext.run('t-1', undefined, () =>
        uc.execute(PATIENT_ID, { from, to }),
      );
      await expect(run).rejects.toBeInstanceOf(BadRequestException);
      await expect(run).rejects.toThrow(message);
      expect(queries).toEqual([]);
    },
  );

  it('366 días (año bisiesto entero) sí valen', async () => {
    const { uc, tenantContext } = makeUseCase();
    await expect(
      tenantContext.run('t-1', undefined, () =>
        uc.execute(PATIENT_ID, { from: '2028-01-01', to: '2028-12-31' }),
      ),
    ).resolves.toMatchObject({ from: '2028-01-01', to: '2028-12-31' });
  });
});
