import {
  PAYMENT_BASE_BACKLOG_HOURS,
  paymentBaseRetryDelayMs,
} from './payment-base-retry';

const MIN = 60_000;

describe('paymentBaseRetryDelayMs (DX-380, OPS-045)', () => {
  it('escalona 1 min → 5 → 30 → 2 h → 24 h tras cada intento fallido', () => {
    expect([1, 2, 3, 4, 5].map(paymentBaseRetryDelayMs)).toEqual([
      1 * MIN,
      5 * MIN,
      30 * MIN,
      120 * MIN,
      1440 * MIN,
    ]);
  });

  it('se queda en 24 h a partir del quinto intento (tope)', () => {
    expect(paymentBaseRetryDelayMs(6)).toBe(1440 * MIN);
    expect(paymentBaseRetryDelayMs(1000)).toBe(1440 * MIN);
  });

  it('rechaza un número de intentos que no es un entero ≥ 1', () => {
    for (const attempts of [0, -1, 1.5, Number.NaN]) {
      expect(() => paymentBaseRetryDelayMs(attempts)).toThrow(RangeError);
    }
  });

  it('el aviso al ADMIN salta pasadas 24 h sin base', () => {
    expect(PAYMENT_BASE_BACKLOG_HOURS).toBe(24);
  });
});
