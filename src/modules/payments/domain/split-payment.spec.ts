import {
  exceedsPending,
  excessOverPending,
  knownSplitTotal,
  splitTotal,
} from './split-payment';
import {
  splitPaymentRequestFingerprint,
  paymentRequestFingerprint,
} from './idempotency';

describe('reglas del cobro dividido (DX-390)', () => {
  it('el total suma al céntimo y es null si alguna línea está sin tasa', () => {
    expect(splitTotal([0.1, 0.2])).toBe(0.3);
    expect(splitTotal([200_000, 100_000.55])).toBe(300_000.55);
    expect(splitTotal([200_000, null])).toBeNull();
  });

  it('lo que se sabe del total cuenta solo las líneas con tasa', () => {
    expect(knownSplitTotal([200_000, null, 50])).toBe(200_050);
  });

  it('superar lo pendiente es al céntimo; un plan ya pagado (o con saldo a favor) tiene 0 pendiente', () => {
    expect(exceedsPending(100, 100)).toBe(false);
    expect(exceedsPending(100.01, 100)).toBe(true);
    expect(exceedsPending(1, -50)).toBe(true);
    expect(exceedsPending(0, 0)).toBe(false);
  });

  // QA DX-390 (B2): un saldo a favor previo no se suma al excedente.
  it('el excedente es lo que el cobro supera lo pendiente, con lo pendiente nunca bajo 0', () => {
    expect(excessOverPending(300, 200)).toBe(100);
    expect(excessOverPending(60_000, -15_000)).toBe(60_000);
    expect(excessOverPending(100, 100)).toBe(0);
    expect(excessOverPending(50, 100)).toBe(0);
    expect(excessOverPending(0.3, 0.1)).toBe(0.2);
  });
});

describe('huella del cobro dividido (DX-390)', () => {
  const PLAN = '44444444-4444-4444-8444-444444444444';
  const lines = [
    { amount: 50, currency: 'usd', paymentMethodId: 'm1', reference: ' A1 ' },
    { amount: 100000, currency: 'COP', paymentMethodId: 'm2' },
  ];

  it('normaliza como la del abono y no depende del motivo ni de la confirmación', () => {
    const a = splitPaymentRequestFingerprint(PLAN, {
      paidAt: '2026-10-30',
      lines,
    });
    const b = splitPaymentRequestFingerprint(PLAN.toUpperCase(), {
      paidAt: '2026-10-30',
      lines: [
        { ...lines[0], currency: 'USD', reference: 'A1' },
        { ...lines[1], amount: 100000.0 },
      ],
    });
    expect(a).toBe(b);
  });

  it('cambia con el orden o el importe de una línea, y nunca coincide con la de un abono suelto', () => {
    const base = splitPaymentRequestFingerprint(PLAN, {
      paidAt: '2026-10-30',
      lines,
    });
    expect(
      splitPaymentRequestFingerprint(PLAN, {
        paidAt: '2026-10-30',
        lines: [lines[1], lines[0]],
      }),
    ).not.toBe(base);
    expect(
      splitPaymentRequestFingerprint(PLAN, {
        paidAt: '2026-10-30',
        lines: [lines[0], { ...lines[1], amount: 99999 }],
      }),
    ).not.toBe(base);
    expect(
      paymentRequestFingerprint(PLAN, {
        amount: 50,
        currency: 'USD',
        paidAt: '2026-10-30',
      }),
    ).not.toBe(base);
  });
});
