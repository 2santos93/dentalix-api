import { BadRequestException } from '@nestjs/common';
import {
  isMissingRateError,
  MissingExchangeRateError,
  UnsupportedCurrencyRateError,
} from './missing-exchange-rate.error';

describe('isMissingRateError (DX-111: por tipo, no por texto)', () => {
  it('reconoce la tasa manual que falta y la moneda que el proveedor no trae', () => {
    expect(
      isMissingRateError(new MissingExchangeRateError('VES', '2026-11-15')),
    ).toBe(true);
    expect(
      isMissingRateError(new UnsupportedCurrencyRateError('VES', '2026-11-15')),
    ).toBe(true);
  });

  it('un 400 cualquiera con el texto de antes ya NO cuenta como «sin tasa»', () => {
    expect(
      isMissingRateError(new BadRequestException('unsupported currency: VES')),
    ).toBe(false);
    expect(isMissingRateError(new Error('boom'))).toBe(false);
  });

  it('la moneda sin tasa del proveedor sale en español y con code', () => {
    const err = new UnsupportedCurrencyRateError('VES', '2026-11-15');
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'EXCHANGE_RATE_UNSUPPORTED',
      message:
        'El proveedor de tasas no publica la tasa de VES para el día 2026-11-15. Puedes registrarla a mano en Ajustes › Tasa de cambio.',
    });
    expect(err.currency).toBe('VES');
  });
});
