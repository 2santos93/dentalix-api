import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HealthController, READINESS_DB_TIMEOUT_MS } from './health.controller';

type QueryRaw = jest.Mock<Promise<unknown>, [TemplateStringsArray]>;

const queryRawMock = (): QueryRaw =>
  jest.fn<Promise<unknown>, [TemplateStringsArray]>();

function controllerWith(queryRaw: QueryRaw): HealthController {
  return new HealthController({ $queryRaw: queryRaw });
}

describe('HealthController', () => {
  afterEach(() => jest.useRealTimers());

  it('liveness: siempre ok y sin tocar la base', () => {
    const queryRaw = queryRawMock();
    expect(controllerWith(queryRaw).check()).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('readiness: ok si la base responde a SELECT 1', async () => {
    const queryRaw = queryRawMock().mockResolvedValue([{ '?column?': 1 }]);
    await expect(controllerWith(queryRaw).ready()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });
    expect(queryRaw.mock.calls[0][0].join('')).toBe('SELECT 1');
  });

  it('readiness: 503 si la base falla', async () => {
    const queryRaw = queryRawMock().mockRejectedValue(
      new Error("Can't reach database server"),
    );
    const result = controllerWith(queryRaw).ready();
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      response: { statusCode: 503, status: 'unavailable', database: 'down' },
      // El filtro global registra el tipo de la causa en su única línea warn.
      cause: { name: 'Error' },
    });
  });

  it('readiness: no escribe log propio (lo hace el filtro global, una sola línea)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const queryRaw = queryRawMock().mockRejectedValue(new Error('down'));
    await expect(controllerWith(queryRaw).ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('readiness: 503 si la base no contesta a tiempo', async () => {
    jest.useFakeTimers();
    const queryRaw = queryRawMock().mockReturnValue(
      new Promise<unknown>(() => undefined),
    );
    const result = controllerWith(queryRaw).ready();
    jest.advanceTimersByTime(READINESS_DB_TIMEOUT_MS);
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      cause: { name: 'DatabaseTimeoutError' },
    });
  });

  it('readiness: no deja el temporizador colgado cuando la base responde', async () => {
    jest.useFakeTimers();
    const queryRaw = queryRawMock().mockResolvedValue([]);
    await controllerWith(queryRaw).ready();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ambas sondas quedan fuera del rate limit', () => {
    const reflector = new Reflector();
    const skip = reflector.get<boolean>(
      'THROTTLER:SKIPdefault',
      HealthController,
    );
    expect(skip).toBe(true);
  });
});
