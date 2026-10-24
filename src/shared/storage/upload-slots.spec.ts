import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  DEFAULT_UPLOAD_TIMEOUTS,
  UPLOAD_BUSY_MESSAGE,
  UploadSlotGuard,
  UploadSlotInterceptor,
  UploadSlots,
} from './upload-slots';
import { Subject, throwError } from 'rxjs';

class FakeResponse extends EventEmitter {
  readonly headers = new Map<string, string>();
  headersSent = false;
  statusCode = 200;
  body = '';
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  end(body: string): void {
    this.headersSent = true;
    this.body = body;
    this.emit('finish');
  }
}

class FakeRequest extends EventEmitter {
  file?: { path: string };
  complete = false;
  destroyed = false;
  idle: { ms: number; cb?: () => void } | null = null;
  setTimeout(ms: number, cb?: () => void): void {
    this.idle = ms === 0 ? null : { ms, cb };
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function contextFor(req: object, res: FakeResponse): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

/** Sondeo en vez de una espera fija (revisión M-5: con carga, 50 ms no bastan). */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('UploadSlots / UploadSlotGuard (DX-259, OPS-038)', () => {
  it('como mucho `capacity` a la vez; devolver es idempotente', () => {
    const slots = new UploadSlots(2);
    const a = slots.tryAcquire();
    const b = slots.tryAcquire();
    expect(slots.tryAcquire()).toBeNull();
    a?.();
    a?.();
    expect(slots.active).toBe(1);
    expect(slots.tryAcquire()).not.toBeNull();
    b?.();
  });

  it('sin plaza: 503 en español con Retry-After, antes de leer el cuerpo', () => {
    const guard = new UploadSlotGuard(new UploadSlots(1));
    const first = new FakeResponse();
    expect(guard.canActivate(contextFor(new FakeRequest(), first))).toBe(true);
    const second = new FakeResponse();
    let error: unknown;
    try {
      guard.canActivate(contextFor(new FakeRequest(), second));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).message).toBe(
      UPLOAD_BUSY_MESSAGE,
    );
    expect(second.headers.get('Retry-After')).toBe('5');
  });

  it('al cerrarse la respuesta devuelve la plaza y borra el temporal de multer', async () => {
    const slots = new UploadSlots(1);
    const guard = new UploadSlotGuard(slots);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'slots-')), 'tmp');
    writeFileSync(file, 'x');
    const req = new FakeRequest();
    const res = new FakeResponse();
    guard.canActivate(contextFor(req, res));
    req.file = { path: file };
    expect(slots.active).toBe(1);
    res.emit('close');
    expect(slots.active).toBe(0);
    await waitFor(() => !existsSync(file));
  });

  it('un cliente lento que pasa del plazo total recibe 408 en español, se corta y la plaza queda libre', () => {
    jest.useFakeTimers();
    try {
      const slots = new UploadSlots(1, {
        idleTimeoutMs: 1000,
        maxDurationMs: 5000,
      });
      const guard = new UploadSlotGuard(slots);
      const req = new FakeRequest();
      const res = new FakeResponse();
      guard.canActivate(contextFor(req, res));
      expect(req.idle?.ms).toBe(1000);
      jest.advanceTimersByTime(4999);
      expect(slots.active).toBe(1);
      jest.advanceTimersByTime(1);
      expect(res.statusCode).toBe(408);
      expect(JSON.parse(res.body)).toMatchObject({
        statusCode: 408,
        message: 'La subida tardó demasiado y se canceló. Vuelve a intentarlo.',
      });
      expect(req.destroyed).toBe(true);
      expect(slots.active).toBe(0);
      // Otro cliente ya tiene plaza.
      expect(
        guard.canActivate(contextFor(new FakeRequest(), new FakeResponse())),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sin recibir nada durante el plazo de inactividad también se corta', () => {
    const slots = new UploadSlots(1, {
      idleTimeoutMs: 1000,
      maxDurationMs: 60_000,
    });
    const req = new FakeRequest();
    const res = new FakeResponse();
    new UploadSlotGuard(slots).canActivate(contextFor(req, res));
    req.idle?.cb?.();
    expect(res.statusCode).toBe(408);
    expect(req.destroyed).toBe(true);
    expect(slots.active).toBe(0);
    res.emit('close');
  });

  it('con el cuerpo ya recibido los plazos se desarman y no cortan nada (revisión I-1)', () => {
    jest.useFakeTimers();
    try {
      const slots = new UploadSlots(1, {
        idleTimeoutMs: 1000,
        maxDurationMs: 2000,
      });
      const req = new FakeRequest();
      const res = new FakeResponse();
      new UploadSlotGuard(slots).canActivate(contextFor(req, res));
      req.complete = true;
      req.emit('end');
      expect(req.idle).toBeNull();
      jest.advanceTimersByTime(10_000);
      expect(res.statusCode).toBe(200);
      expect(req.destroyed).toBe(false);
      expect(slots.active).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('si el interceptor tomó la subida, cerrar la respuesta no libera la plaza: la libera el final del handler (revisión I-1)', () => {
    const slots = new UploadSlots(1);
    const req = new FakeRequest();
    const res = new FakeResponse();
    const ctx = contextFor(req, res);
    new UploadSlotGuard(slots).canActivate(ctx);
    const handler = new Subject<string>();
    const out = new UploadSlotInterceptor().intercept(ctx, {
      handle: () => handler.asObservable(),
    });
    const sub = out.subscribe({ error: () => undefined });
    res.emit('close');
    expect(slots.active).toBe(1);
    handler.next('ok');
    handler.complete();
    expect(slots.active).toBe(0);
    sub.unsubscribe();
  });

  it('el handler que falla también devuelve la plaza', () => {
    const slots = new UploadSlots(1);
    const req = new FakeRequest();
    const res = new FakeResponse();
    const ctx = contextFor(req, res);
    new UploadSlotGuard(slots).canActivate(ctx);
    new UploadSlotInterceptor()
      .intercept(ctx, { handle: () => throwError(() => new Error('x')) })
      .subscribe({ error: () => undefined });
    expect(slots.active).toBe(0);
  });
});

describe('UploadSlots con tope por clave (SEC-046)', () => {
  it('como mucho `perKeyCapacity` por clave, además del tope de la réplica', () => {
    const slots = new UploadSlots(2, DEFAULT_UPLOAD_TIMEOUTS, 1);
    const a = slots.acquire('clinica-a');
    expect('release' in a).toBe(true);
    // La misma clave: sin plaza, aunque a la réplica le queda una.
    expect(slots.acquire('clinica-a')).toEqual({ busy: 'key' });
    expect(slots.activeFor('clinica-a')).toBe(1);
    const b = slots.acquire('clinica-b');
    expect('release' in b).toBe(true);
    // Réplica llena: otra clave tampoco entra.
    expect(slots.acquire('clinica-c')).toEqual({ busy: 'replica' });
    expect(slots.active).toBe(2);
    if ('release' in a) {
      a.release();
      a.release();
    }
    expect(slots.active).toBe(1);
    expect(slots.activeFor('clinica-a')).toBe(0);
    expect('release' in slots.acquire('clinica-a')).toBe(true);
  });

  it('sin clave solo cuenta el tope de la réplica (los usos de DX-259)', () => {
    const slots = new UploadSlots(2, DEFAULT_UPLOAD_TIMEOUTS, 1);
    expect(slots.tryAcquire()).not.toBeNull();
    expect(slots.tryAcquire()).not.toBeNull();
    expect(slots.tryAcquire()).toBeNull();
  });

  it('una clave sin plazas en uso no deja rastro (no crece con cada clínica)', () => {
    const slots = new UploadSlots(4, DEFAULT_UPLOAD_TIMEOUTS, 2);
    for (let i = 0; i < 100; i++) {
      const r = slots.tryAcquire(`clinica-${i}`);
      r?.();
    }
    expect(slots.trackedKeys).toBe(0);
  });
});
