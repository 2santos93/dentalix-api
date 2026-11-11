import {
  receiptMethodLabel,
  receiptSummaryLines,
  receiptSummaryTotals,
  receiptSummaryVoidedCount,
  type ReceiptSummarySourceItem,
} from './receipt-summary';

function item(
  over: Partial<ReceiptSummarySourceItem> = {},
): ReceiptSummarySourceItem {
  return {
    paymentId: 'pay-1',
    locationId: 'loc-1',
    receiptNumber: 'CCS-000001',
    issuedAt: new Date('2026-10-10T15:00:00.000Z'),
    issuedOn: '2026-10-10',
    locationName: 'Sede Altamira',
    voided: false,
    voidReason: null,
    parts: [
      { amount: 100, currency: 'USD', method: 'CASH', paymentMethodName: null },
    ],
    ...over,
  };
}

describe('resumen de recibos (DX-401)', () => {
  it('ordena por emisión y saca una fila por forma de pago de un cobro dividido', () => {
    const later = item({
      paymentId: 'pay-2',
      receiptNumber: 'CCS-000002',
      issuedAt: new Date('2026-10-20T15:00:00.000Z'),
      issuedOn: '2026-10-20',
      parts: [
        {
          amount: 50,
          currency: 'USD',
          method: 'TRANSFER',
          paymentMethodName: 'Zelle',
        },
        {
          amount: 1800,
          currency: 'VES',
          method: 'TRANSFER',
          paymentMethodName: 'Pago móvil',
        },
      ],
    });
    const lines = receiptSummaryLines([later, item()]);
    expect(
      lines.map((l) => [l.receiptNumber, l.currency, l.methodLabel]),
    ).toEqual([
      ['CCS-000001', 'USD', 'Efectivo'],
      ['CCS-000002', 'USD', 'Zelle'],
      ['CCS-000002', 'VES', 'Pago móvil'],
    ]);
    expect(lines[1]).toMatchObject({
      paymentId: 'pay-2',
      issuedOn: '2026-10-20',
      locationName: 'Sede Altamira',
    });
  });

  it('totales POR MONEDA, sin los anulados, sumados al céntimo', () => {
    const lines = receiptSummaryLines([
      item({
        parts: [
          {
            amount: 0.1,
            currency: 'USD',
            method: 'CASH',
            paymentMethodName: null,
          },
        ],
      }),
      item({
        paymentId: 'pay-2',
        receiptNumber: 'CCS-000002',
        parts: [
          {
            amount: 0.2,
            currency: 'USD',
            method: 'CARD',
            paymentMethodName: null,
          },
        ],
      }),
      item({
        paymentId: 'pay-3',
        receiptNumber: 'CCS-000003',
        parts: [
          {
            amount: 3650.5,
            currency: 'VES',
            method: 'TRANSFER',
            paymentMethodName: null,
          },
        ],
      }),
      item({
        paymentId: 'pay-4',
        receiptNumber: 'CCS-000004',
        voided: true,
        voidReason: 'Cobro duplicado',
        parts: [
          {
            amount: 999,
            currency: 'USD',
            method: 'CASH',
            paymentMethodName: null,
          },
        ],
      }),
    ]);
    expect(receiptSummaryTotals(lines)).toEqual([
      { currency: 'USD', amount: 0.3, count: 2 },
      { currency: 'VES', amount: 3650.5, count: 1 },
    ]);
  });

  it('todo anulado o sin recibos: sin totales', () => {
    expect(receiptSummaryTotals([])).toEqual([]);
    const voided = item({ voided: true, voidReason: 'Error' });
    expect(receiptSummaryTotals(receiptSummaryLines([voided]))).toEqual([]);
  });

  it('cuenta los recibos anulados (no sus filas)', () => {
    const split = item({
      voided: true,
      voidReason: 'Error',
      parts: [
        { amount: 1, currency: 'USD', method: 'CASH', paymentMethodName: null },
        { amount: 2, currency: 'VES', method: 'CASH', paymentMethodName: null },
      ],
    });
    expect(receiptSummaryVoidedCount([split, item({ paymentId: 'x' })])).toBe(
      1,
    );
  });

  it('la forma de pago: el medio de la clínica, el método o «Sin especificar»', () => {
    expect(receiptMethodLabel('CARD', '  Punto de venta ')).toBe(
      'Punto de venta',
    );
    expect(receiptMethodLabel('CARD', null)).toBe('Tarjeta');
    expect(receiptMethodLabel('OTHER', '   ')).toBe('Otro');
    expect(receiptMethodLabel(null, null)).toBe('Sin especificar');
  });
});
