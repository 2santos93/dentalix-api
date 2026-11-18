import {
  canonicalJson,
  expenseDescription,
  parsePaymentReference,
  patientInitials,
  planPayment,
  receiptSignatureHash,
  settlementPaymentState,
  type PayableLine,
} from './settlement-payments';

const line = (
  id: string,
  amount: number,
  currency = 'USD',
  paymentId: string | null = null,
): PayableLine => ({ id, amount, currency, paymentId });

describe('settlementPaymentState (DX-464)', () => {
  it('sin pagos y con algo a pagar: pendiente, por moneda y sin convertir', () => {
    const state = settlementPaymentState([
      line('a', 35),
      line('b', 12.5),
      line('c', 1000, 'VES'),
    ]);
    expect(state.status).toBe('UNPAID');
    expect(state.currencies).toEqual([
      { currency: 'USD', total: 47.5, paid: 0, pending: 47.5, pendingLines: 2 },
      { currency: 'VES', total: 1000, paid: 0, pending: 1000, pendingLines: 1 },
    ]);
  });

  it('una moneda pagada y la otra no: pagada parcialmente', () => {
    const state = settlementPaymentState([
      line('a', 35, 'USD', 'p1'),
      line('c', 1000, 'VES'),
    ]);
    expect(state.status).toBe('PARTIALLY_PAID');
  });

  it('todo pagado: pagada; los ajustes negativos pagados con su línea cuentan', () => {
    const state = settlementPaymentState([
      line('a', 35, 'USD', 'p1'),
      line('b', -5, 'USD', 'p1'),
    ]);
    expect(state.status).toBe('PAID');
    expect(state.currencies[0]).toMatchObject({
      total: 30,
      paid: 30,
      pending: 0,
    });
  });

  it('solo ajustes negativos y nada pagado: sin importe a pagar', () => {
    expect(settlementPaymentState([line('a', -5)]).status).toBe(
      'NOTHING_TO_PAY',
    );
    expect(settlementPaymentState([]).status).toBe('NOTHING_TO_PAY');
  });

  it('suma en céntimos (sin errores de coma flotante)', () => {
    const state = settlementPaymentState([line('a', 0.1), line('b', 0.2)]);
    expect(state.currencies[0].total).toBe(0.3);
  });
});

describe('planPayment (DX-464)', () => {
  const lines = [
    line('a', 35),
    line('b', 20),
    line('adj', -5),
    line('v', 1000, 'VES'),
    line('paid', 10, 'USD', 'p0'),
  ];

  it('sin líneas elegidas: todas las pendientes de la moneda', () => {
    expect(planPayment(lines, 'USD', undefined)).toEqual({
      ok: true,
      plan: { lineIds: ['a', 'b', 'adj'], amount: 50 },
    });
  });

  it('algunas líneas (con el ajuste): el importe es su suma', () => {
    expect(planPayment(lines, 'USD', ['a', 'adj'])).toEqual({
      ok: true,
      plan: { lineIds: ['a', 'adj'], amount: 30 },
    });
  });

  it('dejar fuera un ajuste negativo cuando ya no queda margen supera lo pendiente', () => {
    const tight = [line('a', 35), line('adj', -35)];
    expect(planPayment(tight, 'USD', ['a'])).toEqual({
      ok: false,
      error: { code: 'COMMISSION_NOTHING_PENDING' },
    });
    const partial = [line('a', 35), line('adj', -30)];
    expect(planPayment(partial, 'USD', ['a'])).toEqual({
      ok: false,
      error: { code: 'COMMISSION_PAYMENT_EXCEEDS_PENDING', pending: 5 },
    });
  });

  it('una línea de otra moneda, desconocida o ya pagada se rechaza', () => {
    expect(planPayment(lines, 'USD', ['v'])).toMatchObject({
      ok: false,
      error: { code: 'COMMISSION_PAYMENT_LINE_CURRENCY' },
    });
    expect(planPayment(lines, 'USD', ['x'])).toMatchObject({
      ok: false,
      error: { code: 'COMMISSION_PAYMENT_LINE_UNKNOWN' },
    });
    expect(planPayment(lines, 'USD', ['paid'])).toMatchObject({
      ok: false,
      error: { code: 'COMMISSION_LINE_ALREADY_PAID' },
    });
  });

  it('solo el ajuste negativo: el pago no es positivo', () => {
    expect(planPayment(lines, 'USD', ['adj'])).toMatchObject({
      ok: false,
      error: { code: 'COMMISSION_PAYMENT_NOT_POSITIVE' },
    });
  });

  it('una moneda sin nada pendiente (o desconocida): nada que pagar', () => {
    const paid = [line('a', 35, 'USD', 'p1')];
    expect(planPayment(paid, 'USD', undefined)).toMatchObject({
      ok: false,
      error: { code: 'COMMISSION_NOTHING_PENDING' },
    });
    expect(planPayment(lines, 'EUR', undefined)).toMatchObject({
      ok: false,
      error: { code: 'COMMISSION_NOTHING_PENDING' },
    });
  });

  it('cada moneda por separado: VES no se mezcla con USD', () => {
    expect(planPayment(lines, 'VES', undefined)).toEqual({
      ok: true,
      plan: { lineIds: ['v'], amount: 1000 },
    });
  });

  it('una línea repetida en la petición cuenta una vez', () => {
    expect(planPayment(lines, 'USD', ['a', 'a'])).toEqual({
      ok: true,
      plan: { lineIds: ['a'], amount: 35 },
    });
  });
});

describe('textos y huellas (DX-464)', () => {
  it('iniciales del paciente: nunca el nombre', () => {
    expect(patientInitials('María José Pérez')).toBe('M. J. P.');
    expect(patientInitials('  ana   d’alessandro ')).toBe('A. D.');
    expect(patientInitials(null)).toBe('—');
  });

  it('referencia: recortada, sin controles, hasta 120', () => {
    expect(parsePaymentReference('  TRF-0042 ')).toEqual({
      ok: true,
      value: 'TRF-0042',
    });
    expect(parsePaymentReference('')).toEqual({ ok: true, value: null });
    expect(parsePaymentReference('a\nb')).toEqual({ ok: false });
    expect(parsePaymentReference('x'.repeat(121))).toEqual({ ok: false });
  });

  it('descripción del gasto con período y referencia', () => {
    expect(
      expenseDescription({ from: '2026-10-01', to: '2026-10-31' }, 'TRF-1'),
    ).toBe(
      'Liquidación de honorarios del 2026-10-01 al 2026-10-31 · Ref. TRF-1',
    );
  });

  it('JSON canónico: el orden de las claves no cambia la huella', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe(
      canonicalJson({ a: [2, { c: 'x', d: null }], b: 1 }),
    );
  });

  it('la huella de la firma cambia con el nombre o la firma', () => {
    const base = receiptSignatureHash('h', 'Ana', 'png');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptSignatureHash('h', 'Ana B', 'png')).not.toBe(base);
    expect(receiptSignatureHash('h', 'Ana', 'png2')).not.toBe(base);
  });
});
