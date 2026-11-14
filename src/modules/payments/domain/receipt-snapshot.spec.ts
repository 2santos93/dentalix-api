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
    address: 'Av. Libertador 100, Caracas',
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
    currency: 'GBP',
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
    currency: 'GBP',
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
        address: 'Av. Libertador 100, Caracas',
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
        currency: 'GBP',
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
        currency: 'GBP',
        billable: 900000,
        paid: 450000,
        balance: 450000,
      },
      cashier: { id: 'user-1', fullName: 'Recepción Demo' },
      legalNotice: 'Este documento no es factura',
    });
  });

  describe('región de la sede (DX-521, R1)', () => {
    const REGIONAL = {
      timeZone: 'Europe/London',
      locale: 'en-GB',
      hourCycle: 'h23',
    } as const;

    it('congela zona, locale y reloj de la sede si vienen', () => {
      const snapshot = buildReceiptSnapshot(
        input({ regional: REGIONAL }),
        NO_LOCAL_NAMES,
      );
      expect(snapshot.regional).toEqual(REGIONAL);
      expect(snapshot.version).toBe(1);
    });

    it.each([
      ['ausente', undefined],
      ['null (sede sin ajustes válidos)', null],
    ])('%s: la foto es la de antes, sin la clave', (_label, regional) => {
      const snapshot = buildReceiptSnapshot(
        input({ regional }),
        NO_LOCAL_NAMES,
      );
      expect('regional' in snapshot).toBe(false);
      expect(snapshot).toEqual(buildReceiptSnapshot(input(), NO_LOCAL_NAMES));
    });

    it('la foto no comparte el objeto de la entrada', () => {
      const snapshot = buildReceiptSnapshot(
        input({ regional: { ...REGIONAL } }),
        NO_LOCAL_NAMES,
      );
      expect(snapshot.regional).not.toBe(REGIONAL);
    });
  });

  it('nunca guarda el documento del paciente en claro', () => {
    const json = JSON.stringify(buildReceiptSnapshot(input(), NO_LOCAL_NAMES));
    expect(json).not.toContain('1012345678');
  });

  it('con razón social e identificación fiscal de la clínica los datos fiscales no quedan pendientes', () => {
    const snapshot = buildReceiptSnapshot(
      input({
        clinic: {
          name: 'Clínica Demo',
          legalName: 'Clínica Demo C.A.',
          taxId: 'J-12345678-9',
          address: 'Av. Urdaneta 72, Caracas',
        },
      }),
      NO_LOCAL_NAMES,
    );
    expect(snapshot.fiscalDataPending).toBe(false);
    expect(snapshot.clinic.taxId).toBe('J-12345678-9');
  });

  it('sin identificación fiscal (aunque haya razón social) siguen pendientes', () => {
    const snapshot = buildReceiptSnapshot(
      input({
        clinic: {
          name: 'Clínica Demo',
          legalName: 'Clínica Demo C.A.',
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

describe('buildReceiptSnapshot: ajustes por medio de pago (DX-516)', () => {
  const TAX = {
    type: 'TAX' as const,
    label: 'Impuesto 3 %',
    calculation: 'PERCENT' as const,
    percent: 3,
    fixedAmount: null,
    base: 150000,
    amount: 4500,
    currency: 'USD',
  };

  it('sin ajustes la foto es byte a byte la de antes (sin clave nueva)', () => {
    const before = JSON.stringify(
      buildReceiptSnapshot(input(), NO_LOCAL_NAMES),
    );
    for (const adjustments of [undefined, []]) {
      const base = input();
      const snapshot = buildReceiptSnapshot(
        input({ payment: { ...base.payment, adjustments } }),
        NO_LOCAL_NAMES,
      );
      expect(JSON.stringify(snapshot)).toBe(before);
      expect(snapshot.payment).not.toHaveProperty('adjustments');
    }
  });

  it('congela los ajustes del abono con su base e importe, y nada más cambia', () => {
    const plain = buildReceiptSnapshot(input(), NO_LOCAL_NAMES);
    const base = input();
    const snapshot = buildReceiptSnapshot(
      input({ payment: { ...base.payment, adjustments: [TAX] } }),
      NO_LOCAL_NAMES,
    );
    expect(snapshot).toEqual({
      ...plain,
      payment: { ...plain.payment, adjustments: [TAX] },
    });
  });

  it('en un cobro dividido los ajustes van en su línea, no en `payment`', () => {
    const base = input();
    const snapshot = buildReceiptSnapshot(
      input({
        payment: { ...base.payment, adjustments: [TAX] },
        split: {
          planCurrency: 'USD',
          lines: [
            {
              paymentId: 'pay-1',
              line: 1,
              amount: 150000,
              currency: 'USD',
              method: 'CASH',
              paymentMethodName: 'Efectivo',
              reference: null,
              equivalentAmount: 150000,
              adjustments: [TAX],
            },
            {
              paymentId: 'pay-2',
              line: 2,
              amount: 50000,
              currency: 'USD',
              method: 'CARD',
              paymentMethodName: 'Tarjeta',
              reference: null,
              equivalentAmount: 50000,
            },
          ],
        },
      }),
      NO_LOCAL_NAMES,
    );
    expect(snapshot.payment).not.toHaveProperty('adjustments');
    expect(snapshot.split?.lines[0].adjustments).toEqual([TAX]);
    expect(snapshot.split?.lines[1]).not.toHaveProperty('adjustments');
  });
});

describe('buildReceiptSnapshot: texto propio de cada moneda (DX-517)', () => {
  it('sin textos, la foto es byte a byte la de antes', () => {
    const before = JSON.stringify(
      buildReceiptSnapshot(input(), NO_LOCAL_NAMES),
    );
    for (const currencyTexts of [undefined, null, {}]) {
      const snapshot = buildReceiptSnapshot(
        input({ currencyTexts }),
        NO_LOCAL_NAMES,
      );
      expect(JSON.stringify(snapshot)).toBe(before);
      expect(snapshot).not.toHaveProperty('currencyTexts');
    }
  });

  it('congela el mapa de la clínica al emitir (una copia), y nada más cambia', () => {
    const texts = { EUR: '€', VES: 'Bs.' };
    const plain = buildReceiptSnapshot(input(), NO_LOCAL_NAMES);
    const snapshot = buildReceiptSnapshot(
      input({ currencyTexts: texts }),
      NO_LOCAL_NAMES,
    );
    expect(snapshot).toEqual({ ...plain, currencyTexts: texts });
    expect(snapshot.currencyTexts).not.toBe(texts);
  });
});
