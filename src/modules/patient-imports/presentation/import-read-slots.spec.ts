import {
  ServiceUnavailableException,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { Subject, lastValueFrom, of, throwError } from 'rxjs';
import {
  DEFAULT_UPLOAD_TIMEOUTS,
  UploadSlots,
} from '../../../shared/storage/upload-slots';
import {
  IMPORT_READ_BUSY_MESSAGE,
  IMPORT_READ_CLINIC_BUSY_MESSAGE,
  IMPORT_READ_UNAUTHENTICATED_MESSAGE,
  ImportReadSlotInterceptor,
} from './import-read-slots';

class FakeResponse {
  readonly headers = new Map<string, string>();
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function contextFor(
  tenantId: string | undefined,
  res = new FakeResponse(),
): ExecutionContext {
  const req = tenantId ? { user: { tenantId } } : {};
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('ImportReadSlotInterceptor (SEC-046)', () => {
  const build = () => {
    const slots = new UploadSlots(2, DEFAULT_UPLOAD_TIMEOUTS, 1);
    return { slots, interceptor: new ImportReadSlotInterceptor(slots) };
  };

  /** Un handler que no termina hasta que el test lo diga. */
  const pending = () => {
    const subject = new Subject<string>();
    const handler: CallHandler = { handle: () => subject.asObservable() };
    return { subject, handler };
  };

  it('toma la plaza de la clínica mientras corre el handler y la devuelve al terminar', async () => {
    const { slots, interceptor } = build();
    const { subject, handler } = pending();
    const done = lastValueFrom(interceptor.intercept(contextFor('a'), handler));
    expect(slots.activeFor('a')).toBe(1);
    subject.next('ok');
    subject.complete();
    await expect(done).resolves.toBe('ok');
    expect(slots.active).toBe(0);
  });

  it('el handler que falla también la devuelve', async () => {
    const { slots, interceptor } = build();
    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor('a'), {
          handle: () => throwError(() => new Error('x')),
        }),
      ),
    ).rejects.toThrow('x');
    expect(slots.active).toBe(0);
  });

  it('una lectura por clínica: la segunda de la MISMA clínica da 503 en español con Retry-After, sin llamar al handler', () => {
    const { slots, interceptor } = build();
    const { handler } = pending();
    void lastValueFrom(interceptor.intercept(contextFor('a'), handler)).catch(
      () => undefined,
    );
    const res = new FakeResponse();
    const handle = jest.fn(() => of('no'));
    let error: unknown;
    try {
      interceptor.intercept(contextFor('a', res), { handle });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe(IMPORT_READ_CLINIC_BUSY_MESSAGE);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(handle).not.toHaveBeenCalled();
    expect(slots.active).toBe(1);
  });

  it('dos por réplica: con dos clínicas leyendo, una tercera da 503 con su mensaje', () => {
    const { slots, interceptor } = build();
    for (const tenantId of ['a', 'b']) {
      void lastValueFrom(
        interceptor.intercept(contextFor(tenantId), pending().handler),
      ).catch(() => undefined);
    }
    const res = new FakeResponse();
    expect(() =>
      interceptor.intercept(contextFor('c', res), pending().handler),
    ).toThrow(IMPORT_READ_BUSY_MESSAGE);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(slots.active).toBe(2);
  });

  it('sin usuario autenticado: 401 en español y sin plaza', () => {
    const { slots, interceptor } = build();
    let error: unknown;
    try {
      interceptor.intercept(contextFor(undefined), pending().handler);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as Error).message).toBe(IMPORT_READ_UNAUTHENTICATED_MESSAGE);
    expect(slots.active).toBe(0);
  });
});
