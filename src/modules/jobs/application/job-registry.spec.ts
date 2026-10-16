import { JobRegistry } from './job-registry';

const noop = (): Promise<void> => Promise.resolve();

describe('JobRegistry', () => {
  it('registra handlers por nombre con sus valores por defecto', () => {
    const registry = new JobRegistry();
    registry.register({ name: 'auth.purge-expired-tokens', handle: noop });
    registry.register({
      name: 'exchange.prefetch-rates',
      handle: noop,
      maxAttempts: 3,
      retryBaseMs: 10_000,
    });

    expect(registry.names()).toEqual([
      'auth.purge-expired-tokens',
      'exchange.prefetch-rates',
    ]);
    expect(registry.get('exchange.prefetch-rates')).toMatchObject({
      maxAttempts: 3,
      retryBaseMs: 10_000,
    });
    expect(registry.get('auth.purge-expired-tokens')?.maxAttempts).toBe(
      undefined,
    );
    expect(registry.get('no.existe')).toBeUndefined();
  });

  it('un nombre repetido es un error de programación (dos módulos no comparten trabajo)', () => {
    const registry = new JobRegistry();
    registry.register({ name: 'a.b', handle: noop });
    expect(() => registry.register({ name: 'a.b', handle: noop })).toThrow(
      /ya registrado/,
    );
  });

  it.each([
    '',
    'sinpunto',
    'Mayus.cula',
    'a.b c',
    'a..b',
    `a.${'x'.repeat(80)}`,
  ])('rechaza el nombre %p (módulo.trabajo en minúsculas)', (name) => {
    expect(() => new JobRegistry().register({ name, handle: noop })).toThrow(
      /nombre/,
    );
  });

  it('rechaza maxAttempts fuera de 1..25', () => {
    const registry = new JobRegistry();
    expect(() =>
      registry.register({ name: 'a.b', handle: noop, maxAttempts: 0 }),
    ).toThrow(/maxAttempts/);
    expect(() =>
      registry.register({ name: 'a.c', handle: noop, maxAttempts: 26 }),
    ).toThrow(/maxAttempts/);
  });

  it('programa tareas con cron válido sobre un trabajo registrado', () => {
    const registry = new JobRegistry();
    registry.register({ name: 'auth.purge-expired-tokens', handle: noop });
    registry.schedule({
      name: 'auth.purge-expired-tokens.hourly',
      cron: '17 * * * *',
      job: 'auth.purge-expired-tokens',
    });

    expect(registry.schedules()).toEqual([
      {
        name: 'auth.purge-expired-tokens.hourly',
        cron: '17 * * * *',
        job: 'auth.purge-expired-tokens',
        payload: {},
      },
    ]);
  });

  it('una tarea programada exige cron válido, trabajo registrado y nombre único', () => {
    const registry = new JobRegistry();
    registry.register({ name: 'a.b', handle: noop });
    expect(() =>
      registry.schedule({ name: 'a.b.cada', cron: '* * *', job: 'a.b' }),
    ).toThrow(/cron/);
    expect(() =>
      registry.schedule({ name: 'a.c.cada', cron: '* * * * *', job: 'a.c' }),
    ).toThrow(/no registrado/);
    registry.schedule({ name: 'a.b.cada', cron: '* * * * *', job: 'a.b' });
    expect(() =>
      registry.schedule({ name: 'a.b.cada', cron: '* * * * *', job: 'a.b' }),
    ).toThrow(/ya programada/);
  });
});
