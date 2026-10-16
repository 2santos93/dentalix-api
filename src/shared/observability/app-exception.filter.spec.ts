import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppExceptionFilter } from './app-exception.filter';
import { AppLogger, LogSink } from './app-logger';
import { requestContext } from './request-context';

interface Sent {
  status?: number;
  body?: unknown;
  ended?: boolean;
}

function setup(): {
  filter: AppExceptionFilter;
  lines: Record<string, unknown>[];
  host: (opts?: { headersSent?: boolean }) => ArgumentsHost;
  sent: Sent;
} {
  const lines: Record<string, unknown>[] = [];
  const sink: LogSink = (_s, line) =>
    lines.push(JSON.parse(line) as Record<string, unknown>);
  const filter = new AppExceptionFilter(
    new AppLogger({ level: 'debug', format: 'json' }, sink),
  );
  const sent: Sent = {};
  const host = (opts: { headersSent?: boolean } = {}): ArgumentsHost =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          baseUrl: '',
          route: { path: '/api/v1/patients' },
          url: '/api/v1/patients?query=Juan',
          body: { firstName: 'Juan' },
        }),
        getResponse: () => ({
          headersSent: opts.headersSent ?? false,
          end() {
            sent.ended = true;
          },
          status(code: number) {
            sent.status = code;
            return {
              json(body: unknown) {
                sent.body = body;
              },
            };
          },
        }),
      }),
    }) as unknown as ArgumentsHost;
  return { filter, lines, host, sent };
}

const inRequest = (fn: () => void): void =>
  requestContext.run({ requestId: 'req-abcdef12' }, fn);

describe('AppExceptionFilter', () => {
  it('un 4xx sale igual que con el filtro de Nest y no se registra como error', () => {
    const { filter, lines, host, sent } = setup();
    const exception = new BadRequestException(['firstName must be a string']);
    inRequest(() => filter.catch(exception, host()));
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual(exception.getResponse());
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('un HttpException con respuesta en texto se envuelve como hace Nest', () => {
    const { filter, host, sent } = setup();
    filter.catch(new HttpException('Nope', 418), host());
    expect(sent).toEqual({
      status: 418,
      body: { statusCode: 418, message: 'Nope' },
    });
  });

  it('un error no controlado es un 500 genérico con request id y SIN stack', () => {
    const { filter, host, sent } = setup();
    const boom = new Error('fallo interno con paciente Juan');
    inRequest(() => filter.catch(boom, host()));
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Ocurrió un error procesando la solicitud.',
      requestId: 'req-abcdef12',
    });
    const text = JSON.stringify(sent.body);
    expect(text).not.toContain('at ');
    expect(text).not.toContain('Juan');
  });

  it('el 500 se registra con request id, método, ruta plantilla y los marcos del stack, SIN el mensaje', () => {
    const { filter, lines, host } = setup();
    const boom = new TypeError('fallo con el paciente Juan Pérez');
    inRequest(() => filter.catch(boom, host()));
    const errors = lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      context: 'ExceptionFilter',
      requestId: 'req-abcdef12',
      method: 'POST',
      route: '/api/v1/patients',
      status: 500,
      error: 'TypeError',
    });
    const stack = String(errors[0].stack);
    expect(stack.split('\n')[0]).toBe('TypeError');
    expect(stack).toMatch(/\n\s+at /);
    // Ni el mensaje (puede llevar datos), ni la query, ni el cuerpo.
    const text = JSON.stringify(errors[0]);
    expect(text).not.toContain('Juan');
    expect(text).not.toContain('query=');
    expect(text).not.toContain('firstName');
  });

  it.each([
    [
      'PrismaClientValidationError',
      () =>
        new Prisma.PrismaClientValidationError(
          'Invalid `prisma.patient.create()` invocation:\n{ data: { fullName: "Juan Pérez" } }\nUnknown argument `fullName`.',
          { clientVersion: '6.19.3' },
        ),
    ],
    [
      'PrismaClientRustPanicError',
      () =>
        new Prisma.PrismaClientRustPanicError(
          'panic: query { where: { fullName: "Juan Pérez" } }',
          '6.19.3',
        ),
    ],
    [
      'PrismaClientInitializationError',
      () =>
        new Prisma.PrismaClientInitializationError(
          "Can't reach database server for Juan Pérez",
          '6.19.3',
        ),
    ],
  ])('%s: 500 genérico y log sin los argumentos de la query', (name, make) => {
    const { filter, lines, host, sent } = setup();
    inRequest(() => filter.catch(make(), host()));
    expect(sent.status).toBe(500);
    const errors = lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ error: name, requestId: 'req-abcdef12' });
    expect(String(errors[0].stack).split('\n')[0]).toBe(name);
    expect(JSON.stringify(lines)).not.toContain('Juan');
    expect(JSON.stringify(sent.body)).not.toContain('Juan');
  });

  it('un HttpException 5xx lanzado a propósito conserva su cuerpo, añade el request id y queda en UNA línea warn sin stack', () => {
    const { filter, lines, host, sent } = setup();
    const exception = new ServiceUnavailableException(
      { status: 'unavailable', database: 'down' },
      { cause: new Error('timeout hablando con Juan') },
    );
    inRequest(() => filter.catch(exception, host()));
    expect(sent).toEqual({
      status: 503,
      body: {
        status: 'unavailable',
        database: 'down',
        requestId: 'req-abcdef12',
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      status: 503,
      requestId: 'req-abcdef12',
      error: 'ServiceUnavailableException',
      cause: 'Error',
    });
    expect(lines[0]).not.toHaveProperty('stack');
    expect(JSON.stringify(lines[0])).not.toContain('Juan');
  });

  it('lanzar algo que no es un Error también es un 500 genérico', () => {
    const { filter, lines, host, sent } = setup();
    inRequest(() => filter.catch('texto suelto', host()));
    expect(sent.status).toBe(500);
    expect(lines.filter((l) => l.level === 'error')[0]).toMatchObject({
      error: 'NonError',
    });
  });

  it('delega los errores de Prisma en PrismaExceptionFilter (P2002 → 409)', () => {
    const { filter, host, sent } = setup();
    filter.catch(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: 'patients_tenant_doc_key' },
      }),
      host(),
    );
    expect(sent.status).toBe(409);
  });

  it('si la respuesta ya salió no la reescribe, pero la cierra', () => {
    const { filter, lines, host, sent } = setup();
    inRequest(() =>
      filter.catch(new Error('tarde'), host({ headersSent: true })),
    );
    expect(sent).toEqual({ ended: true });
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(1);
  });

  it('el 403 de CORS no se registra como error', () => {
    const { filter, lines, host, sent } = setup();
    filter.catch(new ForbiddenException('Origin not allowed'), host());
    expect(sent.status).toBe(403);
    expect(lines).toEqual([]);
  });
});
