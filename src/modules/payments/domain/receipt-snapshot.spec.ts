import {
  RECEIPT_LEGAL_NOTICE,
  buildReceiptSnapshot,
  parseReceiptSnapshot,
  type ReceiptSnapshotInput,
} from './receipt-snapshot';

const input = (
  overrides: Partial<ReceiptSnapshotInput> = {},
): ReceiptSnapshotInput => ({
  clinic: { name: 'Clínica Demo', legalName: null, taxId: null, address: null },
  location: {
    id: 'loc-1',
    name: 'Sede Norte',
    address: 'Calle 100 # 15-20, Bogotá',
  },
  patient: {
    id: 'pat-1',
    firstName: 'Carolina',
    lastName: 'Duque',
    docType: 'CC',
    docNumber: '1012345678',
  },
  payment: {
    id: 'pay-1',
    amount: 150000,
    currency: 'COP',
    method: 'CASH',
    paidAt: new Date('2026-10-17T17:00:00.000Z'),
    paidOn: '2026-10-17',
  },
  plan: {
    id: 'plan-1',
    optionLabel: 'Opción A: implante',
    createdAt: new Date('2026-09-01T15:00:00.000Z'),
  },
  planBalance: {
    currency: 'COP',
    billable: 900000,
    paid: 450000,
    balance: 450000,
  },
  cashier: { id: 'user-1', fullName: 'Recepción Demo' },
  ...overrides,
});

describe('buildReceiptSnapshot (DX-136)', () => {
  it('congela clínica, sede, paciente, abono, plan, saldo y quién cobró', () => {
    expect(buildReceiptSnapshot(input())).toEqual({
      version: 1,
      clinic: {
        name: 'Clínica Demo',
        legalName: null,
        taxId: null,
        address: null,
      },
      location: {
        id: 'loc-1',
        name: 'Sede Norte',
        address: 'Calle 100 # 15-20, Bogotá',
      },
      fiscalDataPending: true,
      patient: {
        id: 'pat-1',
        fullName: 'Carolina Duque',
        docType: 'CC',
        docNumberMasked: '******5678',
      },
      payment: {
        id: 'pay-1',
        amount: 150000,
        currency: 'COP',
        method: 'CASH',
        paidAt: '2026-10-17T17:00:00.000Z',
        paidOn: '2026-10-17',
      },
      plan: {
        id: 'plan-1',
        optionLabel: 'Opción A: implante',
        createdAt: '2026-09-01T15:00:00.000Z',
      },
      // DX-262: un abono a un plan no tiene saldo migrado.
      openingBalance: null,
      planBalance: {
        currency: 'COP',
        billable: 900000,
        paid: 450000,
        balance: 450000,
      },
      cashier: { id: 'user-1', fullName: 'Recepción Demo' },
      legalNotice: 'Este documento no es factura',
    });
  });

  it('nunca guarda el documento del paciente en claro', () => {
    const json = JSON.stringify(buildReceiptSnapshot(input()));
    expect(json).not.toContain('1012345678');
  });

  it('con razón social y NIT de la clínica los datos fiscales no quedan pendientes', () => {
    const snapshot = buildReceiptSnapshot(
      input({
        clinic: {
          name: 'Clínica Demo',
          legalName: 'Clínica Demo S.A.S.',
          taxId: '900123456-7',
          address: 'Cra 7 # 72-10, Bogotá',
        },
      }),
    );
    expect(snapshot.fiscalDataPending).toBe(false);
    expect(snapshot.clinic.taxId).toBe('900123456-7');
  });

  it('sin NIT (aunque haya razón social) siguen pendientes', () => {
    const snapshot = buildReceiptSnapshot(
      input({
        clinic: {
          name: 'Clínica Demo',
          legalName: 'Clínica Demo S.A.S.',
          taxId: '  ',
          address: null,
        },
      }),
    );
    expect(snapshot.fiscalDataPending).toBe(true);
    expect(snapshot.clinic.taxId).toBeNull();
  });

  it('sin documento, sin método, sin saldo y sin cajero: campos nulos, nunca inventados', () => {
    const snapshot = buildReceiptSnapshot(
      input({
        patient: {
          id: 'pat-1',
          firstName: ' Ana ',
          lastName: 'Ruiz',
          docType: 'CC',
          docNumber: null,
        },
        payment: { ...input().payment, method: null },
        planBalance: null,
        cashier: null,
      }),
    );
    expect(snapshot.patient).toEqual({
      id: 'pat-1',
      fullName: 'Ana Ruiz',
      docType: 'CC',
      docNumberMasked: null,
    });
    expect(snapshot.payment.method).toBeNull();
    expect(snapshot.planBalance).toBeNull();
    expect(snapshot.cashier).toBeNull();
  });

  it('el aviso legal por defecto es «Este documento no es factura»', () => {
    expect(RECEIPT_LEGAL_NOTICE).toBe('Este documento no es factura');
  });

  it('parseReceiptSnapshot acepta la versión 1 y rechaza lo demás', () => {
    const snapshot = buildReceiptSnapshot(input());
    expect(parseReceiptSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(
      snapshot,
    );
    expect(() => parseReceiptSnapshot({ version: 2 })).toThrow();
    expect(() => parseReceiptSnapshot(null)).toThrow();
  });
});
