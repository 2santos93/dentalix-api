import { loadLogConfig } from './log-config';

const envOf =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key];

describe('loadLogConfig', () => {
  it('en producción usa JSON e info por defecto', () => {
    expect(loadLogConfig(envOf({ NODE_ENV: 'production' }))).toEqual({
      level: 'info',
      format: 'json',
    });
  });

  it('en tests no escribe nada por defecto (no ensucia la salida de jest)', () => {
    expect(loadLogConfig(envOf({ NODE_ENV: 'test' }))).toEqual({
      level: 'silent',
      format: 'json',
    });
  });

  it('sin NODE_ENV usa JSON e info', () => {
    expect(loadLogConfig(envOf({}))).toEqual({
      level: 'info',
      format: 'json',
    });
  });

  it('respeta LOG_LEVEL y LOG_FORMAT (sin distinguir mayúsculas)', () => {
    expect(
      loadLogConfig(
        envOf({ NODE_ENV: 'test', LOG_LEVEL: 'DEBUG', LOG_FORMAT: 'pretty' }),
      ),
    ).toEqual({ level: 'debug', format: 'pretty' });
  });

  it('un valor vacío equivale a no definirlo', () => {
    expect(
      loadLogConfig(
        envOf({ NODE_ENV: 'production', LOG_LEVEL: '', LOG_FORMAT: '' }),
      ),
    ).toEqual({ level: 'info', format: 'json' });
  });

  it('rechaza un LOG_LEVEL desconocido diciendo los válidos', () => {
    expect(() => loadLogConfig(envOf({ LOG_LEVEL: 'trace' }))).toThrow(
      /LOG_LEVEL.*silent, error, warn, info, debug/,
    );
  });

  it('rechaza un LOG_FORMAT desconocido', () => {
    expect(() => loadLogConfig(envOf({ LOG_FORMAT: 'xml' }))).toThrow(
      /LOG_FORMAT.*json, pretty/,
    );
  });
});
