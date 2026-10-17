import { receiptEmailVars } from './receipt-email-vars';
import { buildReceiptSnapshot } from '../../domain/receipt-snapshot';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';

const snapshot = buildReceiptSnapshot({
  clinic: { name: 'Clínica Demo', legalName: null, taxId: null, address: null },
  location: { id: 'loc-1', name: 'Sede Norte', address: 'Cra 15 # 93-60' },
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
  cashier: { id: 'u-1', fullName: 'Recepción Demo' },
});

const view = (
  overrides: Partial<PaymentReceiptView> = {},
): PaymentReceiptView => ({
  paymentId: 'pay-1',
  reference: 'NOR-000123',
  seriesPrefix: 'NOR',
  number: 123,
  legacy: false,
  issuedAt: new Date('2026-10-17T17:00:05.000Z'),
  voided: false,
  voidedAt: null,
  voidReason: null,
  snapshot,
  ...overrides,
});

describe('receiptEmailVars (DX-136)', () => {
  it('arma el email desde la foto del recibo, con el documento enmascarado', () => {
    const { amountLabel, balanceLabel, ...vars } = receiptEmailVars(view());
    expect(amountLabel).toMatch(/^150\.000,00\sCOP$/);
    expect(balanceLabel).toMatch(/^450\.000,00\sCOP$/);
    expect(vars).toEqual({
      patientName: 'Carolina Duque',
      reference: 'NOR-000123',
      legacy: false,
      locationName: 'Sede Norte',
      locationAddress: 'Cra 15 # 93-60',
      fiscalLine: null,
      patientDocLabel: 'CC ******5678',
      paidOnLabel: '17/10/2026',
      methodLabel: 'Efectivo',
      planLabel: 'Plan del 01/09/2026 · Opción A: implante',
      cashierName: 'Recepción Demo',
      voided: null,
      legalNotice: 'Este documento no es factura',
    });
    expect(JSON.stringify(vars)).not.toContain('1012345678');
  });

  it('anulado: fecha (día de Bogotá) y motivo', () => {
    const vars = receiptEmailVars(
      view({
        voided: true,
        voidedAt: new Date('2026-10-18T02:00:00.000Z'),
        voidReason: 'Cobro duplicado',
      }),
    );
    expect(vars.voided).toEqual({
      dateLabel: '17/10/2026',
      reason: 'Cobro duplicado',
    });
  });

  it('las fechas son días civiles de la zona de la sede del recibo', () => {
    const vars = receiptEmailVars(
      view({
        voided: true,
        voidedAt: new Date('2026-10-18T02:00:00.000Z'),
        voidReason: 'Cobro duplicado',
      }),
      'Europe/Madrid',
    );
    // 02:00 UTC del 18 es el 17 en Bogotá, pero ya el 18 en Madrid.
    expect(vars.voided?.dateLabel).toBe('18/10/2026');
  });

  it('con razón social y NIT, la línea fiscal; sin método, «Sin especificar»', () => {
    const vars = receiptEmailVars(
      view({
        snapshot: {
          ...snapshot,
          fiscalDataPending: false,
          clinic: {
            name: 'Clínica Demo',
            legalName: 'Clínica Demo S.A.S.',
            taxId: '900123456-7',
            address: null,
          },
          payment: { ...snapshot.payment, method: null },
          plan: { ...snapshot.plan, optionLabel: null },
        },
      }),
    );
    expect(vars.fiscalLine).toBe('Clínica Demo S.A.S. · NIT/NIF 900123456-7');
    expect(vars.methodLabel).toBe('Sin especificar');
    expect(vars.planLabel).toBe('Plan del 01/09/2026');
  });
});
