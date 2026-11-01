import {
  RECEIPT_LEGAL_NOTICE,
  buildReceiptSnapshot,
  parseReceiptSnapshot,
  receiptPatientView,
  type ReceiptSnapshot,
  type ReceiptSnapshotInput,
} from './receipt-snapshot';
import { NO_LOCAL_NAMES } from '../../document-type-names/__fixtures__/fixed-document-type-names.reader';

const LOCAL = { ...NO_LOCAL_NAMES, NATIONAL_ID: 'Documento A' };

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
    docType: 'NATIONAL_ID',
    docTypeLabel: null,
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
    expect(buildReceiptSnapshot(input(), NO_LOCAL_NAMES)).toEqual({
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
        documentType: 'NATIONAL_ID',
        docTypeLabel: null,
        docTypeName: 'Documento nacional',
        docNumberMasked: '******5678',
      },
      payment: {
        id: 'pay-1',
        amount: 150000,
        currency: 'COP',
        method: 'CASH',
        // DX-377: sin medio ni referencia en la entrada, nulos.
        paymentMethodName: null,
        reference: null,
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
    const json = JSON.stringify(buildReceiptSnapshot(input(), NO_LOCAL_NAMES));
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
      NO_LOCAL_NAMES,
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
      NO_LOCAL_NAMES,
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
          docType: 'NATIONAL_ID',
          docTypeLabel: null,
          docNumber: null,
        },
        payment: { ...input().payment, method: null },
        planBalance: null,
        cashier: null,
      }),
      NO_LOCAL_NAMES,
    );
    expect(snapshot.patient).toEqual({
      id: 'pat-1',
      fullName: 'Ana Ruiz',
      documentType: 'NATIONAL_ID',
      docTypeLabel: null,
      docTypeName: 'Documento nacional',
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
    const snapshot = buildReceiptSnapshot(input(), NO_LOCAL_NAMES);
    expect(parseReceiptSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(
      snapshot,
    );
    expect(() => parseReceiptSnapshot({ version: 2 })).toThrow();
    expect(() => parseReceiptSnapshot(null)).toThrow();
  });
});

describe('receiptPatientView (DX-327)', () => {
  it('a new snapshot carries the generic type, the label and the frozen display name, and no old code', () => {
    const labelled = buildReceiptSnapshot(
      input({
        patient: {
          ...input().patient,
          docType: 'TAX_ID',
          docTypeLabel: 'ID local',
        },
      }),
      LOCAL,
    );
    expect(labelled.version).toBe(1);
    expect(labelled.patient).toMatchObject({
      documentType: 'TAX_ID',
      docTypeLabel: 'ID local',
      docTypeName: 'ID local',
    });
    expect(labelled.patient).not.toHaveProperty('docType');

    const local = buildReceiptSnapshot(input(), LOCAL);
    expect(local.patient.docTypeName).toBe('Documento A');
    // Lo congelado manda: cambiar el nombre local después no lo cambia.
    const stored = parseReceiptSnapshot(JSON.parse(JSON.stringify(local)));
    expect(
      receiptPatientView(stored, { ...LOCAL, NATIONAL_ID: 'Documento B' }),
    ).toEqual({
      id: 'pat-1',
      fullName: 'Carolina Duque',
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docTypeName: 'Documento A',
      docNumberMasked: '******5678',
    });
  });

  it("an old snapshot with only the old code reads as NATIONAL_ID with no label and the clinic's current name, or the generic one", () => {
    // Tal como la guardó la versión anterior a DX-327: solo el código.
    const legacy = parseReceiptSnapshot({
      ...JSON.parse(JSON.stringify(buildReceiptSnapshot(input(), LOCAL))),
      patient: {
        id: 'pat-1',
        fullName: 'Carolina Duque',
        docType: 'CC',
        docNumberMasked: '******5678',
      },
    });
    expect(receiptPatientView(legacy, LOCAL)).toEqual({
      id: 'pat-1',
      fullName: 'Carolina Duque',
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docTypeName: 'Documento A',
      docNumberMasked: '******5678',
    });
    expect(receiptPatientView(legacy, NO_LOCAL_NAMES).docTypeName).toBe(
      'Documento nacional',
    );
    // El código CE es un permiso de residencia, nunca una etiqueta.
    const ce = {
      ...legacy,
      patient: { ...legacy.patient, docType: 'CE' },
    } as ReceiptSnapshot;
    expect(receiptPatientView(ce, NO_LOCAL_NAMES)).toMatchObject({
      docType: 'RESIDENCE_PERMIT',
      docTypeLabel: null,
      docTypeName: 'Permiso de residencia',
    });
  });

  it('a snapshot with an unknown code throws', () => {
    const snapshot = buildReceiptSnapshot(input(), NO_LOCAL_NAMES);
    const unknown = {
      ...snapshot,
      patient: {
        id: 'pat-1',
        fullName: 'Carolina Duque',
        docType: 'XX',
        docNumberMasked: null,
      },
    } as unknown as ReceiptSnapshot;
    expect(() => receiptPatientView(unknown, NO_LOCAL_NAMES)).toThrow(
      'tipo de documento guardado desconocido',
    );
    const toString = {
      ...unknown,
      patient: { ...unknown.patient, docType: 'toString' },
    } as unknown as ReceiptSnapshot;
    expect(() => receiptPatientView(toString, NO_LOCAL_NAMES)).toThrow();
  });
});

describe('buildReceiptSnapshot: título y leyenda del recibo (DX-515)', () => {
  it('sin título ni leyenda configurados, la foto es byte a byte la de antes', () => {
    const before = JSON.stringify(
      buildReceiptSnapshot(input(), NO_LOCAL_NAMES),
    );
    for (const texts of [undefined, null, { title: null, legend: null }]) {
      const snapshot = buildReceiptSnapshot(input({ texts }), NO_LOCAL_NAMES);
      expect(JSON.stringify(snapshot)).toBe(before);
      expect(snapshot).not.toHaveProperty('title');
      expect(snapshot).not.toHaveProperty('legend');
    }
  });

  it('congela el título y la leyenda configurados al emitir, y nada más cambia', () => {
    const plain = buildReceiptSnapshot(input(), NO_LOCAL_NAMES);
    const snapshot = buildReceiptSnapshot(
      input({
        texts: {
          title: 'Recibo de pago',
          legend: 'Este recibo no es una factura',
        },
      }),
      NO_LOCAL_NAMES,
    );
    expect(snapshot).toEqual({
      ...plain,
      title: 'Recibo de pago',
      legend: 'Este recibo no es una factura',
    });
  });

  it('solo la leyenda, o solo el título: la otra clave no aparece', () => {
    const onlyLegend = buildReceiptSnapshot(
      input({ texts: { title: null, legend: 'Sin valor fiscal' } }),
      NO_LOCAL_NAMES,
    );
    expect(onlyLegend.legend).toBe('Sin valor fiscal');
    expect(onlyLegend).not.toHaveProperty('title');
    const onlyTitle = buildReceiptSnapshot(
      input({ texts: { title: 'Recibo de pago', legend: null } }),
      NO_LOCAL_NAMES,
    );
    expect(onlyTitle.title).toBe('Recibo de pago');
    expect(onlyTitle).not.toHaveProperty('legend');
  });
});
