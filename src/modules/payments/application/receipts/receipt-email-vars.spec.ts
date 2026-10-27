import { receiptEmailVars } from './receipt-email-vars';
import { buildReceiptSnapshot } from '../../domain/receipt-snapshot';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';
import { regionalFormat } from '../../../../shared/format/regional-format';

const SNAPSHOT_INPUT = {
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
} satisfies Parameters<typeof buildReceiptSnapshot>[0];
const snapshot = buildReceiptSnapshot(SNAPSHOT_INPUT);

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

/** Zona y formato de la sede del recibo en estos casos (ajustes explícitos). */
const SEDE_ZONE = 'America/Bogota';
const SEDE_FMT = regionalFormat({ locale: 'es-CO', hourCycle: 'h23' });

describe('receiptEmailVars (DX-136)', () => {
  it('arma el email desde la foto del recibo, con el documento enmascarado', () => {
    const { amountLabel, balanceLabel, ...vars } = receiptEmailVars(
      view(),
      SEDE_ZONE,
      SEDE_FMT,
    );
    expect(amountLabel).toBe(SEDE_FMT.money(150000, 'COP'));
    expect(amountLabel).toMatch(/^\$\s150\.000,00$/);
    expect(balanceLabel).toMatch(/^\$\s450\.000,00$/);
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
      toOpeningBalance: false,
      cashierName: 'Recepción Demo',
      voided: null,
      legalNotice: 'Este documento no es factura',
    });
    expect(JSON.stringify(vars)).not.toContain('1012345678');
  });

  it('anulado: fecha (día civil de la sede) y motivo', () => {
    const vars = receiptEmailVars(
      view({
        voided: true,
        voidedAt: new Date('2026-10-18T02:00:00.000Z'),
        voidReason: 'Cobro duplicado',
      }),
      SEDE_ZONE,
      SEDE_FMT,
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
      'Europe/Berlin',
      SEDE_FMT,
    );
    // 02:00 UTC del 18 es el 17 en UTC-5, pero ya el 18 en Berlín.
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
          plan: { ...snapshot.plan!, optionLabel: null },
        },
      }),
      SEDE_ZONE,
      SEDE_FMT,
    );
    expect(vars.fiscalLine).toBe('Clínica Demo S.A.S. · NIT/NIF 900123456-7');
    expect(vars.methodLabel).toBe('Sin especificar');
    expect(vars.planLabel).toBe('Plan del 01/09/2026');
    expect(vars.toOpeningBalance).toBe(false);
  });

  it('DX-262: un abono contra el saldo migrado dice su concepto y su fecha de corte', () => {
    const vars = receiptEmailVars(
      view({
        snapshot: {
          ...snapshot,
          plan: null,
          openingBalance: {
            id: 'ob-1',
            concept: 'Ortodoncia (programa anterior)',
            asOfDate: '2026-03-15',
          },
        },
      }),
      SEDE_ZONE,
      SEDE_FMT,
    );
    expect(vars.planLabel).toBe(
      'Saldo migrado · Ortodoncia (programa anterior) · corte 15/03/2026',
    );
    expect(vars.toOpeningBalance).toBe(true);
  });

  it('receipt email for a JPY location shows no decimals', () => {
    const jpy = buildReceiptSnapshot({
      ...SNAPSHOT_INPUT,
      payment: { ...SNAPSHOT_INPUT.payment, amount: 12000, currency: 'JPY' },
      planBalance: {
        currency: 'JPY',
        billable: 50000,
        paid: 12000,
        balance: 38000,
      },
    });
    const vars = receiptEmailVars(
      view({ snapshot: jpy }),
      'Asia/Tokyo',
      regionalFormat({ locale: 'ja-JP', hourCycle: 'h23' }),
    );
    expect(vars.amountLabel).toBe('￥12,000');
    expect(vars.balanceLabel).toBe('￥38,000');
  });

  it('receipt email dates follow the location locale (en-US 10/27/2026)', () => {
    const vars = receiptEmailVars(
      view({
        snapshot: {
          ...snapshot,
          payment: { ...snapshot.payment, paidOn: '2026-10-27' },
        },
        voided: true,
        voidedAt: new Date('2026-10-28T15:00:00.000Z'),
        voidReason: 'Cobro duplicado',
      }),
      'America/New_York',
      regionalFormat({ locale: 'en-US', hourCycle: 'h12' }),
    );
    expect(vars.paidOnLabel).toBe('10/27/2026');
    expect(vars.planLabel).toBe('Plan del 09/01/2026 · Opción A: implante');
    expect(vars.voided?.dateLabel).toBe('10/28/2026');
  });
});
