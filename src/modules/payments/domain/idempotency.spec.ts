import { createHash } from 'node:crypto';
import {
  paymentRequestFingerprint,
  paymentRequestFingerprints,
} from './idempotency';

/*
 * DX-570: el vuelto entra en la huella de la Idempotency-Key solo si viene:
 * las huellas guardadas antes siguen reconociendo su reintento.
 */
describe('huella del abono con vuelto (DX-570)', () => {
  const PLAN = '11111111-1111-4111-8111-111111111111';
  const MOBILE = '22222222-2222-4222-8222-222222222222';
  const body = {
    amount: 45,
    currency: 'USD',
    paidAt: '2026-11-19',
    paymentMethodId: '33333333-3333-4333-8333-333333333333',
  };

  it('sin vuelto, la huella es la de siempre (byte a byte)', () => {
    const before = createHash('sha256')
      .update(
        JSON.stringify([
          PLAN,
          '45.00',
          'USD',
          '2026-11-19',
          null,
          null,
          body.paymentMethodId,
          null,
        ]),
      )
      .digest('hex');
    expect(paymentRequestFingerprint(PLAN, body)).toBe(before);
    expect(paymentRequestFingerprint(PLAN, { ...body, change: [] })).toBe(
      before,
    );
  });

  it('lo recibido, cada línea y la confirmación del resto cambian la huella', () => {
    const plain = paymentRequestFingerprint(PLAN, body);
    const tendered = paymentRequestFingerprint(PLAN, { ...body, tendered: 50 });
    const withLine = paymentRequestFingerprint(PLAN, {
      ...body,
      tendered: 50,
      change: [{ paymentMethodId: MOBILE, currency: 'VES', amount: 182.5 }],
    });
    const otherAmount = paymentRequestFingerprint(PLAN, {
      ...body,
      tendered: 50,
      change: [{ paymentMethodId: MOBILE, currency: 'VES', amount: 182 }],
    });
    const confirmed = paymentRequestFingerprint(PLAN, {
      ...body,
      tendered: 50,
      changeRemainderToCredit: true,
    });
    expect(
      new Set([plain, tendered, withLine, otherAmount, confirmed]).size,
    ).toBe(5);
  });

  it('se normaliza igual que el resto: moneda, importe, mayúsculas del id y espacios de la referencia', () => {
    const a = paymentRequestFingerprints(PLAN, {
      ...body,
      tendered: 50,
      change: [
        {
          paymentMethodId: MOBILE.toUpperCase(),
          currency: 'ves',
          amount: 182.5,
          reference: ' 0412 ',
        },
      ],
    });
    const b = paymentRequestFingerprint(PLAN, {
      ...body,
      tendered: 50.0,
      change: [
        {
          paymentMethodId: MOBILE,
          currency: 'VES',
          amount: 182.5,
          reference: '0412',
        },
      ],
    });
    expect(a).toEqual([b]);
  });
});
