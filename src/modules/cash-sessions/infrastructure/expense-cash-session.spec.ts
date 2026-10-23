import { adjustmentReasonOf } from './expense-cash-session';

describe('anulación de una salida de caja en una caja cerrada (DX-274)', () => {
  it('el motivo del ajuste cabe en el CHECK de DX-027 (3–300 caracteres)', () => {
    expect(adjustmentReasonOf('  Pago duplicado ')).toBe('Pago duplicado');
    const long = 'ñ'.repeat(500);
    const cut = adjustmentReasonOf(long);
    expect(Array.from(cut)).toHaveLength(300);
    expect(cut.endsWith('…')).toBe(true);
    expect(adjustmentReasonOf('x'.repeat(300))).toBe('x'.repeat(300));
  });
});
