import { describeJobError, jobRetryDelayMs } from './backoff';

describe('jobRetryDelayMs', () => {
  it('exponencial desde la base tras cada fallo (1.º fallo = base)', () => {
    expect(jobRetryDelayMs(1, 30_000)).toBe(30_000);
    expect(jobRetryDelayMs(2, 30_000)).toBe(60_000);
    expect(jobRetryDelayMs(3, 30_000)).toBe(120_000);
    expect(jobRetryDelayMs(4, 30_000)).toBe(240_000);
  });

  it('con tope de 1 h y sin desbordar con intentos absurdos', () => {
    expect(jobRetryDelayMs(10, 30_000)).toBe(3_600_000);
    expect(jobRetryDelayMs(10_000, 30_000)).toBe(3_600_000);
  });

  it('un intento 0 o negativo cuenta como el primero; la base mínima es 1 ms', () => {
    expect(jobRetryDelayMs(0, 500)).toBe(500);
    expect(jobRetryDelayMs(-3, 500)).toBe(500);
    expect(jobRetryDelayMs(1, 0)).toBe(1);
  });
});

describe('describeJobError', () => {
  it('tipo y código, nunca el mensaje (puede llevar datos del paciente)', () => {
    const err = Object.assign(new Error('ana@clinica.co no existe'), {
      code: 'P2025',
    });
    expect(describeJobError(err)).toBe('Error P2025');
    class ProviderDown extends Error {
      override name = 'ProviderDown';
    }
    expect(describeJobError(new ProviderDown('x'))).toBe('ProviderDown');
    expect(describeJobError('texto suelto')).toBe('UnknownError');
  });
});
