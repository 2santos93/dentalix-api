import { tooManyRequestsException } from './too-many-requests';

describe('tooManyRequestsException', () => {
  it('es un 429 con el formato de errores de la API y mensaje en español', () => {
    const ex = tooManyRequestsException(42);
    expect(ex.getStatus()).toBe(429);
    expect(ex.getResponse()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Demasiadas solicitudes. Intenta de nuevo en 42 segundos.',
    });
  });

  it.each([
    [1, 'Intenta de nuevo en 1 segundo.'],
    [119, 'Intenta de nuevo en 119 segundos.'],
    [120, 'Intenta de nuevo en 2 minutos.'],
    [900, 'Intenta de nuevo en 15 minutos.'],
    [901, 'Intenta de nuevo en 16 minutos.'],
  ])('expresa %i s de espera de forma legible', (seconds, tail) => {
    const body = tooManyRequestsException(seconds).getResponse() as {
      message: string;
    };
    expect(body.message).toBe(`Demasiadas solicitudes. ${tail}`);
  });
});
