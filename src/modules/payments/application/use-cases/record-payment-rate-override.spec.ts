import { BadRequestException } from '@nestjs/common';
import {
  RATE_OVERRIDE_NOT_NEEDED_MESSAGE,
  RATE_OVERRIDE_PAIR_MESSAGE,
  overrideFrozenRate,
} from './record-payment.use-case';

/** DX-569: la tasa que fija recepción al confirmar un pago reportado. */
describe('overrideFrozenRate (DX-569)', () => {
  it('bolívares a un plan en USD: la tasa es la de la moneda del abono', () => {
    expect(overrideFrozenRate('VES', 'USD', 251.5, '2026-11-14')).toEqual({
      currency: 'USD',
      fromPerBase: 251.5,
      toPerBase: 1,
      source: 'MANUAL',
      date: '2026-11-14',
      quotedOn: '2026-11-14',
    });
  });

  it('dólares a un plan en bolívares: la tasa es la del destino', () => {
    expect(overrideFrozenRate('USD', 'VES', 250, '2026-11-14')).toMatchObject({
      currency: 'VES',
      fromPerBase: 1,
      toPerBase: 250,
    });
  });

  it('sin USD en el par, o en la misma moneda, es 400 en español', () => {
    expect(() => overrideFrozenRate('VES', 'EUR', 2, '2026-11-14')).toThrow(
      new BadRequestException(RATE_OVERRIDE_PAIR_MESSAGE),
    );
    expect(() => overrideFrozenRate('USD', 'USD', 2, '2026-11-14')).toThrow(
      new BadRequestException(RATE_OVERRIDE_NOT_NEEDED_MESSAGE),
    );
  });
});
