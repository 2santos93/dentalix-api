import {
  cashOutflowFingerprint,
  expensePaymentFingerprint,
  expenseRequestFingerprint,
  parseIdempotencyKey,
} from './expense-idempotency';

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const EXPENSE = '9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10';

describe('idempotencia de gastos (DX-274)', () => {
  describe('cabecera', () => {
    it('vacía o ausente es «sin clave»; un UUID vale; otra cosa es inválida', () => {
      expect(parseIdempotencyKey(undefined)).toBeUndefined();
      expect(parseIdempotencyKey('   ')).toBeUndefined();
      expect(parseIdempotencyKey(`  ${KEY.toUpperCase()} `)).toBe(KEY);
      expect(parseIdempotencyKey('no-es-uuid')).toBeNull();
    });
  });

  describe('huella de un pago', () => {
    const base = { amount: 50000, method: 'TRANSFER', paidOn: '2026-10-23' };

    it('es la misma para el mismo cuerpo, aunque cambie la grafía del importe', () => {
      expect(expensePaymentFingerprint(EXPENSE, base)).toBe(
        expensePaymentFingerprint(EXPENSE.toUpperCase(), {
          ...base,
          amount: 50000.0,
        }),
      );
    });

    it.each([
      ['otro gasto', () => expensePaymentFingerprint('x'.repeat(8), base)],
      [
        'otro importe',
        () => expensePaymentFingerprint(EXPENSE, { ...base, amount: 50000.01 }),
      ],
      [
        'otro medio',
        () => expensePaymentFingerprint(EXPENSE, { ...base, method: 'CARD' }),
      ],
      [
        'otro día',
        () =>
          expensePaymentFingerprint(EXPENSE, { ...base, paidOn: '2026-10-22' }),
      ],
      [
        'sin día',
        () =>
          expensePaymentFingerprint(EXPENSE, { ...base, paidOn: undefined }),
      ],
      [
        'desde la caja',
        () =>
          expensePaymentFingerprint(EXPENSE, {
            ...base,
            fromCashSession: true,
          }),
      ],
    ])('cambia con %s', (_name, other) => {
      expect(other()).not.toBe(expensePaymentFingerprint(EXPENSE, base));
    });
  });

  describe('huella de un alta', () => {
    const base = {
      category: 'Papelería',
      supplier: 'Papelería Luna',
      description: 'Resmas',
      amount: 120000,
      currency: 'COP',
      invoiceDate: '2026-10-20',
      dueDate: '2026-11-20',
      payment: { amount: 20000, method: 'CASH', paidOn: '2026-10-20' },
    };

    it('ignora espacios de más, mayúsculas de la moneda y vacíos equivalentes', () => {
      expect(expenseRequestFingerprint(base)).toBe(
        expenseRequestFingerprint({
          ...base,
          category: ' Papelería  ',
          supplier: '  Papelería   Luna ',
          currency: 'cop',
        }),
      );
      expect(expenseRequestFingerprint({ ...base, supplier: '' })).toBe(
        expenseRequestFingerprint({ ...base, supplier: null }),
      );
    });

    it.each([
      ['otro importe', { amount: 120001 }],
      ['otra moneda', { currency: 'USD' }],
      ['otra categoría', { category: 'Otros' }],
      ['otra factura', { invoiceDate: '2026-10-21' }],
      ['sin vencimiento', { dueDate: undefined }],
      ['sin pago', { payment: undefined }],
      ['otro pago', { payment: { amount: 1, method: 'CASH' } }],
      ['con soporte', { attachmentUploadId: KEY }],
      ['otra sede', { locationId: KEY }],
    ])('cambia con %s', (_name, patch) => {
      expect(expenseRequestFingerprint({ ...base, ...patch })).not.toBe(
        expenseRequestFingerprint(base),
      );
    });
  });

  describe('huella de una salida de caja', () => {
    const base = {
      category: 'Mensajería',
      supplier: 'Rappi',
      amount: 15000,
      currency: 'COP',
    };

    it('ignora espacios, mayúsculas de la moneda y vacíos equivalentes', () => {
      expect(cashOutflowFingerprint(base)).toBe(
        cashOutflowFingerprint({
          ...base,
          supplier: '  Rappi ',
          currency: 'cop',
          description: '',
        }),
      );
    });

    it('cambia con el importe y no coincide con la de un alta normal', () => {
      expect(cashOutflowFingerprint({ ...base, amount: 15000.01 })).not.toBe(
        cashOutflowFingerprint(base),
      );
      expect(cashOutflowFingerprint(base)).not.toBe(
        expenseRequestFingerprint({ ...base, invoiceDate: '2026-10-23' }),
      );
    });
  });
});
