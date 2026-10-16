import { AppLogger, LogSink } from './app-logger';
import { LogConfig } from './log-config';
import { requestContext } from './request-context';

function capture(config: LogConfig): {
  logger: AppLogger;
  lines: { stream: 'stdout' | 'stderr'; line: string }[];
  json: () => Record<string, unknown>[];
} {
  const lines: { stream: 'stdout' | 'stderr'; line: string }[] = [];
  const sink: LogSink = (stream, line) => lines.push({ stream, line });
  return {
    logger: new AppLogger(config, sink, () => new Date('2026-10-16T12:00:00Z')),
    lines,
    json: () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>),
  };
}

describe('AppLogger', () => {
  it('escribe una línea JSON por evento con hora, nivel, contexto y mensaje', () => {
    const { logger, lines, json } = capture({ level: 'info', format: 'json' });
    logger.log('Arrancada', 'Bootstrap');
    expect(lines).toHaveLength(1);
    expect(lines[0].stream).toBe('stdout');
    expect(lines[0].line.endsWith('\n')).toBe(true);
    expect(lines[0].line.trimEnd()).not.toContain('\n');
    expect(json()[0]).toEqual({
      time: '2026-10-16T12:00:00.000Z',
      level: 'info',
      context: 'Bootstrap',
      msg: 'Arrancada',
    });
  });

  it('incluye el request id de la petición en curso', () => {
    const { logger, json } = capture({ level: 'info', format: 'json' });
    requestContext.run({ requestId: 'req-12345678' }, () => {
      logger.warn('Algo raro', 'Pagos');
    });
    expect(json()[0]).toMatchObject({
      level: 'warn',
      requestId: 'req-12345678',
      context: 'Pagos',
    });
  });

  it('filtra por nivel: con warn no escribe info ni debug', () => {
    const { logger, json } = capture({ level: 'warn', format: 'json' });
    logger.debug('d');
    logger.verbose('v');
    logger.log('i');
    logger.warn('w');
    logger.error('e');
    expect(json().map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('silent no escribe nada, ni errores', () => {
    const { logger, lines } = capture({ level: 'silent', format: 'json' });
    logger.error('e', 'stack', 'Ctx');
    logger.fatal('f');
    expect(lines).toEqual([]);
  });

  it('los errores van a stderr con su stack (firma de Nest: mensaje, stack, contexto)', () => {
    const { logger, lines, json } = capture({ level: 'info', format: 'json' });
    const stack = 'Error: boom\n    at handler (a.ts:1:1)';
    logger.error('Falló', stack, 'ExceptionsHandler');
    expect(lines[0].stream).toBe('stderr');
    expect(json()[0]).toMatchObject({
      level: 'error',
      context: 'ExceptionsHandler',
      msg: 'Falló',
      stack,
    });
  });

  it('error con un solo parámetro lo toma como contexto si no es un stack', () => {
    const { logger, json } = capture({ level: 'info', format: 'json' });
    logger.error('Falló', 'Ctx');
    expect(json()[0]).toEqual(
      expect.objectContaining({ context: 'Ctx', msg: 'Falló' }),
    );
    expect(json()[0]).not.toHaveProperty('stack');
  });

  it('un Error como mensaje registra su mensaje y su stack', () => {
    const { logger, json } = capture({ level: 'info', format: 'json' });
    logger.error(new Error('boom'));
    expect(json()[0]).toMatchObject({ msg: 'boom' });
    expect(String(json()[0].stack)).toContain('Error: boom');
  });

  it('entry() escribe campos estructurados y redacta los sensibles', () => {
    const { logger, json } = capture({ level: 'info', format: 'json' });
    logger.entry('info', 'Access', 'GET /x 200', {
      status: 200,
      headers: { authorization: 'Bearer secreto', accept: '*/*' },
    });
    expect(json()[0]).toMatchObject({
      context: 'Access',
      msg: 'GET /x 200',
      status: 200,
      headers: { authorization: '[REDACTED]', accept: '*/*' },
    });
  });

  it('un objeto como mensaje se registra como campos redactados', () => {
    const { logger, json } = capture({ level: 'info', format: 'json' });
    logger.log({ event: 'x', password: 'S3cret!!' }, 'Ctx');
    expect(json()[0]).toMatchObject({
      event: 'x',
      password: '[REDACTED]',
      context: 'Ctx',
    });
    expect(JSON.stringify(json()[0])).not.toContain('S3cret!!');
  });

  it('los campos estructurados no pisan los del sobre (time, level, requestId)', () => {
    const { logger, json } = capture({ level: 'info', format: 'json' });
    requestContext.run({ requestId: 'req-real-0001' }, () => {
      logger.entry('info', 'Access', 'x', {
        level: 'fatal',
        requestId: 'falso',
        time: 'ayer',
      });
    });
    expect(json()[0]).toMatchObject({
      level: 'info',
      requestId: 'req-real-0001',
      time: '2026-10-16T12:00:00.000Z',
    });
  });

  it('pretty: una línea legible con nivel, contexto, mensaje y campos', () => {
    const { logger, lines } = capture({ level: 'info', format: 'pretty' });
    requestContext.run({ requestId: 'req-12345678' }, () => {
      logger.entry('info', 'Access', 'GET /api/v1/health 200', {
        durationMs: 3,
        tenantId: null,
      });
    });
    expect(lines[0].line).toBe(
      '2026-10-16T12:00:00.000Z INFO  [Access] GET /api/v1/health 200 requestId=req-12345678 durationMs=3 tenantId=null\n',
    );
  });

  it('pretty: los saltos de línea del mensaje se escapan (una línea por evento)', () => {
    const { logger, lines } = capture({ level: 'info', format: 'pretty' });
    logger.log('primera\nINFO  [Falso] inyectada\r\nfin', 'Ctx');
    expect(lines[0].line).toBe(
      '2026-10-16T12:00:00.000Z INFO  [Ctx] primera\\nINFO  [Falso] inyectada\\r\\nfin\n',
    );
  });

  it('pretty: el stack va en las líneas siguientes', () => {
    const { logger, lines } = capture({ level: 'info', format: 'pretty' });
    logger.error('Falló', 'Error: x\n    at y', 'Ctx');
    expect(lines[0].line).toBe(
      '2026-10-16T12:00:00.000Z ERROR [Ctx] Falló\nError: x\n    at y\n',
    );
  });
});
