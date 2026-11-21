import { paymentRateUsed } from './payment-exchange-rate';

describe('paymentRateUsed (DX-586)', () => {
  const quotedAt = new Date('2026-11-20T14:15:00.000Z');

  it('bolívares a un plan en USD: «1 USD = 918,77 VES» con la fuente BCV y su fecha valor', () => {
    expect(
      paymentRateUsed('VES', {
        currency: 'USD',
        fromPerBase: 918.7662,
        toPerBase: 1,
        source: 'BCV',
        date: '2026-11-21',
        ref: 'BCV:2026-11-20',
        valueDate: '2026-11-20',
        quotedAt,
      }),
    ).toEqual({
      rate: 918.7662,
      unit: 'USD',
      currency: 'VES',
      source: 'BCV',
      valueDate: '2026-11-20',
      quotedAt: '2026-11-20T14:15:00.000Z',
      ref: 'BCV:2026-11-20',
    });
  });

  it('dólares a un plan en bolívares: la unidad sigue siendo la moneda más fuerte', () => {
    expect(
      paymentRateUsed('USD', {
        currency: 'VES',
        fromPerBase: 1,
        toPerBase: 918.77,
        source: 'MANUAL',
        date: '2026-11-20',
        ref: 'MANUAL:0190f0a0-0000-7000-8000-000000000001',
        valueDate: null,
        quotedAt,
      }),
    ).toMatchObject({ rate: 918.77, unit: 'USD', currency: 'VES' });
  });

  it('una tasa congelada antes de DX-586 (sin referencia ni instante) no tiene «tasa usada»', () => {
    expect(
      paymentRateUsed('VES', {
        currency: 'USD',
        fromPerBase: 36.5,
        toPerBase: 1,
        source: 'MANUAL',
        date: '2026-10-30',
      }),
    ).toBeNull();
    expect(paymentRateUsed('VES', null)).toBeNull();
  });
});
