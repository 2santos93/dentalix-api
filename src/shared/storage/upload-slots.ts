import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { removeLocalFile } from './local-file';

export const UPLOAD_SLOTS = Symbol('UPLOAD_SLOTS');

/** Segundos de `Retry-After` cuando no quedan plazas de subida. */
export const UPLOAD_BUSY_RETRY_AFTER_SECONDS = 5;

export const UPLOAD_BUSY_MESSAGE =
  'Hay demasiadas subidas en curso. Inténtalo de nuevo en unos segundos.';

/**
 * DX-259 (OPS-038): semáforo de las subidas que pasan por la API en esta
 * réplica (`UPLOAD_MAX_CONCURRENCY`, por defecto 4). No hay cola: sin plaza,
 * 503 con `Retry-After` al momento, antes de leer el cuerpo.
 */
export class UploadSlots {
  private inUse = 0;

  constructor(readonly capacity: number) {}

  get active(): number {
    return this.inUse;
  }

  /** Una plaza y la función que la devuelve (idempotente), o null si no hay. */
  tryAcquire(): (() => void) | null {
    if (this.inUse >= this.capacity) return null;
    this.inUse += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= 1;
    };
  }
}

interface UploadRequest {
  file?: { path?: string };
}

interface UploadResponse {
  setHeader(name: string, value: string): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * Guard de las rutas que reciben un fichero (va DESPUÉS de la autenticación y
 * ANTES de multer, que corre en un interceptor): reserva una plaza o responde
 * 503 sin leer el cuerpo. Al cerrarse la respuesta (terminada o cortada)
 * devuelve la plaza y borra el temporal que dejó multer en disco.
 */
@Injectable()
export class UploadSlotGuard implements CanActivate {
  constructor(@Inject(UPLOAD_SLOTS) private readonly slots: UploadSlots) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<UploadRequest>();
    const res = http.getResponse<UploadResponse>();
    const release = this.slots.tryAcquire();
    if (!release) {
      res.setHeader('Retry-After', String(UPLOAD_BUSY_RETRY_AFTER_SECONDS));
      throw new ServiceUnavailableException(UPLOAD_BUSY_MESSAGE);
    }
    res.once('close', () => {
      release();
      void removeLocalFile(req.file?.path).catch(() => undefined);
    });
    return true;
  }
}
