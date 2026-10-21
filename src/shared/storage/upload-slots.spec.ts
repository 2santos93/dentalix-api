import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  UPLOAD_BUSY_MESSAGE,
  UploadSlotGuard,
  UploadSlots,
} from './upload-slots';

class FakeResponse extends EventEmitter {
  readonly headers = new Map<string, string>();
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function contextFor(req: object, res: FakeResponse): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
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
    expect(guard.canActivate(contextFor({}, first))).toBe(true);
    const second = new FakeResponse();
    let error: unknown;
    try {
      guard.canActivate(contextFor({}, second));
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
    const req: { file?: { path: string } } = {};
    const res = new FakeResponse();
    guard.canActivate(contextFor(req, res));
    req.file = { path: file };
    expect(slots.active).toBe(1);
    res.emit('close');
    expect(slots.active).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(file)).toBe(false);
  });
});
