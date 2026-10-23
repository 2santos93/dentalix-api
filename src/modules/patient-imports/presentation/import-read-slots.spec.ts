import { EventEmitter } from 'node:events';
import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import {
  DEFAULT_UPLOAD_TIMEOUTS,
  UploadSlots,
} from '../../../shared/storage/upload-slots';
import {
  IMPORT_READ_BUSY_MESSAGE,
  IMPORT_READ_CLINIC_BUSY_MESSAGE,
  ImportReadSlotGuard,
} from './import-read-slots';

/** Respuestas del test: al final se cierran para desarmar los plazos del guard. */
const responses: EventEmitter[] = [];

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    responses.push(this);
  }
  readonly headers = new Map<string, string>();
  headersSent = false;
  statusCode = 200;
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  end(): void {
    this.headersSent = true;
  }
}

class FakeRequest extends EventEmitter {
  complete = false;
  constructor(readonly user?: { tenantId?: string }) {
    super();
  }
  setTimeout(): void {}
  destroy(): void {}
}

function contextFor(req: object, res: FakeResponse): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function busyOf(guard: ImportReadSlotGuard, tenantId: string) {
  const res = new FakeResponse();
  let error: unknown;
  try {
    guard.canActivate(contextFor(new FakeRequest({ tenantId }), res));
  } catch (e) {
    error = e;
  }
  return { error, retryAfter: res.headers.get('Retry-After') };
}

describe('ImportReadSlotGuard (SEC-046)', () => {
  afterEach(() => {
    responses.splice(0).forEach((res) => res.emit('close'));
  });

  const build = () => {
    const slots = new UploadSlots(2, DEFAULT_UPLOAD_TIMEOUTS, 1);
    return { slots, guard: new ImportReadSlotGuard(slots) };
  };

  it('una lectura por clínica: la segunda de la MISMA clínica da 503 en español con Retry-After', () => {
    const { slots, guard } = build();
    expect(
      guard.canActivate(
        contextFor(new FakeRequest({ tenantId: 'a' }), new FakeResponse()),
      ),
    ).toBe(true);
    const { error, retryAfter } = busyOf(guard, 'a');
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe(IMPORT_READ_CLINIC_BUSY_MESSAGE);
    expect(retryAfter).toBe('5');
    expect(slots.active).toBe(1);
  });

  it('dos por réplica: con dos clínicas leyendo, una tercera da 503 con su mensaje', () => {
    const { slots, guard } = build();
    for (const tenantId of ['a', 'b']) {
      guard.canActivate(
        contextFor(new FakeRequest({ tenantId }), new FakeResponse()),
      );
    }
    const { error, retryAfter } = busyOf(guard, 'c');
    expect((error as Error).message).toBe(IMPORT_READ_BUSY_MESSAGE);
    expect(retryAfter).toBe('5');
    expect(slots.active).toBe(2);
  });

  it('sin usuario autenticado no toma plaza (va después de JwtAuthGuard)', () => {
    const { slots, guard } = build();
    expect(() =>
      guard.canActivate(contextFor(new FakeRequest(), new FakeResponse())),
    ).toThrow(UnauthorizedException);
    expect(slots.active).toBe(0);
  });

  it('al cerrarse la respuesta la plaza de la clínica vuelve', () => {
    const { slots, guard } = build();
    const res = new FakeResponse();
    guard.canActivate(contextFor(new FakeRequest({ tenantId: 'a' }), res));
    res.emit('close');
    expect(slots.active).toBe(0);
    expect(slots.activeFor('a')).toBe(0);
  });
});
