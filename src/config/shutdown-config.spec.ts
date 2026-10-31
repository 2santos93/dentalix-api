import {
  DEFAULT_SHUTDOWN_DRAIN_MS_PRODUCTION,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  loadShutdownConfig,
  shutdownConfigProblems,
} from './shutdown-config';

const getter =
  (env: Record<string, string>) =>
  (key: string): string | undefined =>
    env[key];

describe('shutdown-config (DX-083)', () => {
  it('en producción drena por defecto; fuera, Ctrl+C inmediato', () => {
    expect(loadShutdownConfig(getter({ NODE_ENV: 'production' }))).toEqual({
      drainMs: DEFAULT_SHUTDOWN_DRAIN_MS_PRODUCTION,
      timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    });
    expect(loadShutdownConfig(getter({ NODE_ENV: 'development' }))).toEqual({
      drainMs: 0,
      timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    });
  });

  it('el drenado más el tope caben en el periodo de gracia recomendado (45 s)', () => {
    expect(
      DEFAULT_SHUTDOWN_DRAIN_MS_PRODUCTION + DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ).toBeLessThan(45_000);
  });

  it('lee SHUTDOWN_DRAIN_MS y SHUTDOWN_TIMEOUT_MS', () => {
    expect(
      loadShutdownConfig(
        getter({
          NODE_ENV: 'production',
          SHUTDOWN_DRAIN_MS: '0',
          SHUTDOWN_TIMEOUT_MS: ' 5000 ',
        }),
      ),
    ).toEqual({ drainMs: 0, timeoutMs: 5000 });
  });

  it('rechaza valores fuera de rango o que no son enteros', () => {
    expect(shutdownConfigProblems(getter({}))).toEqual([]);
    expect(
      shutdownConfigProblems(
        getter({ SHUTDOWN_DRAIN_MS: '120000', SHUTDOWN_TIMEOUT_MS: '1000' }),
      ),
    ).toEqual([]);
    expect(
      shutdownConfigProblems(
        getter({ SHUTDOWN_DRAIN_MS: '-1', SHUTDOWN_TIMEOUT_MS: '999' }),
      ),
    ).toEqual([
      'SHUTDOWN_DRAIN_MS debe ser un entero entre 0 y 120000 (ms).',
      'SHUTDOWN_TIMEOUT_MS debe ser un entero entre 1000 y 600000 (ms).',
    ]);
    expect(
      shutdownConfigProblems(getter({ SHUTDOWN_DRAIN_MS: '10s' })),
    ).toHaveLength(1);
  });
});
