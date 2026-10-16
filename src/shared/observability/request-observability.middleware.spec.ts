import { EventEmitter } from 'node:events';
import { AppLogger, LogSink } from './app-logger';
import { currentRequestId } from './request-context';
import {
  ObservedRequest,
  ObservedResponse,
  accessLogFields,
  requestObservabilityMiddleware,
} from './request-observability.middleware';

class FakeResponse extends EventEmitter implements ObservedResponse {
  statusCode = 200;
  writableFinished = false;
  headers: Record<string, string> = {};
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  finish(status: number): void {
    this.statusCode = status;
    this.writableFinished = true;
    this.emit('finish');
    this.emit('close');
  }
}

function setup(): {
  lines: Record<string, unknown>[];
  middleware: ReturnType<typeof requestObservabilityMiddleware>;
} {
  const lines: Record<string, unknown>[] = [];
  const sink: LogSink = (_s, line) =>
    lines.push(JSON.parse(line) as Record<string, unknown>);
  let tick = 0n;
  const clock = (): bigint => {
    // 12,5 ms entre la llegada y el cierre.
    tick += 12_500_000n;
    return tick;
  };
  const logger = new AppLogger({ level: 'info', format: 'json' }, sink);
  return { lines, middleware: requestObservabilityMiddleware(logger, clock) };
}

const request = (over: Partial<ObservedRequest> = {}): ObservedRequest => ({
  method: 'GET',
  headers: {},
  baseUrl: '',
  ...over,
});

describe('requestObservabilityMiddleware', () => {
  it('genera un request id, lo devuelve en X-Request-Id y lo deja en el contexto', () => {
    const { middleware } = setup();
    const res = new FakeResponse();
    let seen: string | undefined;
    middleware(request(), res, () => {
      seen = currentRequestId();
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toBe(res.headers['x-request-id']);
  });

  it('respeta un X-Request-Id válido del cliente', () => {
    const { middleware } = setup();
    const res = new FakeResponse();
    middleware(
      request({ headers: { 'x-request-id': 'lb-req-00000042' } }),
      res,
      () => undefined,
    );
    expect(res.headers['x-request-id']).toBe('lb-req-00000042');
  });

  it('reemplaza un X-Request-Id con caracteres de control (inyección en el log)', () => {
    const { middleware } = setup();
    const res = new FakeResponse();
    middleware(
      request({ headers: { 'x-request-id': 'abcd1234\r\nlevel=error' } }),
      res,
      () => undefined,
    );
    expect(res.headers['x-request-id']).not.toContain('abcd1234');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('al cerrar la respuesta escribe UNA línea de acceso con la ruta plantilla', () => {
    const { lines, middleware } = setup();
    const req = request({
      method: 'PATCH',
      // La URL real (con id y query) nunca se registra; solo la plantilla.
      url: '/api/v1/patients/9b1e?query=Juan',
      headers: {
        authorization: 'Bearer eyJ.secreto.firma',
        cookie: 'dx_refresh=abc',
      },
      body: { firstName: 'Juan', password: 'S3cret!!' },
    });
    const res = new FakeResponse();
    middleware(req, res, () => {
      // Lo que dejan el router, TenantHostMiddleware y JwtAuthGuard.
      req.route = { path: '/api/v1/patients/:id' };
      req.tenantHost = { host: 'sonrisa.localhost', tenantId: 'tenant-1' };
      req.user = { sub: 'user-1' };
    });
    res.finish(204);

    expect(lines).toHaveLength(1);
    const { time, ...line } = lines[0];
    expect(typeof time).toBe('string');
    expect(line).toEqual({
      level: 'info',
      context: 'Access',
      requestId: res.headers['x-request-id'],
      msg: 'PATCH /api/v1/patients/:id 204',
      method: 'PATCH',
      route: '/api/v1/patients/:id',
      status: 204,
      durationMs: 12.5,
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    const text = JSON.stringify(lines[0]);
    for (const leaked of [
      'Juan',
      'S3cret',
      'eyJ',
      'dx_refresh',
      'query=',
      '9b1e',
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it('sin ruta casada (404) no registra la URL cruda', () => {
    const { lines, middleware } = setup();
    const res = new FakeResponse();
    middleware(
      request({ url: '/api/v1/pacientes/Juan-Perez' }),
      res,
      () => undefined,
    );
    res.finish(404);
    expect(lines[0]).toMatchObject({
      route: null,
      status: 404,
      tenantId: null,
      userId: null,
    });
    expect(JSON.stringify(lines[0])).not.toContain('Juan');
  });

  it('marca la petición abortada por el cliente', () => {
    const { lines, middleware } = setup();
    const res = new FakeResponse();
    middleware(request(), res, () => undefined);
    res.emit('close');
    expect(lines[0]).toMatchObject({ aborted: true });
  });

  it('una sola línea aunque la respuesta emita finish y close', () => {
    const { lines, middleware } = setup();
    const res = new FakeResponse();
    middleware(request(), res, () => undefined);
    res.finish(200);
    expect(lines).toHaveLength(1);
  });
});

describe('accessLogFields', () => {
  it('compone la ruta con el baseUrl del router montado', () => {
    expect(
      accessLogFields(
        request({ baseUrl: '/api/v1', route: { path: '/health/ready' } }),
        { statusCode: 503, writableFinished: true },
        4.25,
      ),
    ).toMatchObject({
      route: '/api/v1/health/ready',
      status: 503,
      durationMs: 4.25,
    });
  });
});
