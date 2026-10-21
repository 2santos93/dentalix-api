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

export const UPLOAD_TIMEOUT_MESSAGE =
  'La subida tardó demasiado y se canceló. Vuelve a intentarlo.';

/**
 * DX-259: plazos de una subida que pasa por la API. Sin ellos, un cliente
 * lento (10 B/s) retiene su plaza hasta el `requestTimeout` de Node (300 s) y
 * unos pocos dejan a todos sin subir.
 */
export interface UploadTimeouts {
  /** Sin recibir nada durante esto, se corta (`UPLOAD_IDLE_TIMEOUT_MS`). */
  idleTimeoutMs: number;
  /** Duración máxima de la subida entera (`UPLOAD_MAX_DURATION_MS`). */
  maxDurationMs: number;
}

export const DEFAULT_UPLOAD_TIMEOUTS: UploadTimeouts = {
  idleTimeoutMs: 15_000,
  maxDurationMs: 120_000,
};

/**
 * DX-259 (OPS-038): semáforo de las subidas que pasan por la API en esta
 * réplica (`UPLOAD_MAX_CONCURRENCY`, por defecto 4). No hay cola: sin plaza,
 * 503 con `Retry-After` al momento, antes de leer el cuerpo.
 */
export class UploadSlots {
  private inUse = 0;

  constructor(
    readonly capacity: number,
    readonly timeouts: UploadTimeouts = DEFAULT_UPLOAD_TIMEOUTS,
  ) {}

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
  setTimeout(ms: number, callback: () => void): unknown;
  destroy(): unknown;
}

interface UploadResponse {
  headersSent: boolean;
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
  once(event: 'close' | 'finish', listener: () => void): unknown;
}

/**
 * Guard de las rutas que reciben un fichero (va DESPUÉS de la autenticación y
 * ANTES de multer, que corre en un interceptor): reserva una plaza o responde
 * 503 sin leer el cuerpo. Mientras dura, la subida tiene un plazo de
 * inactividad y uno total (`UploadTimeouts`): al vencer responde 408 y corta
 * la conexión. Al cerrarse la respuesta (terminada, cortada o vencida)
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
    const expire = () => {
      if (!res.headersSent) {
        res.statusCode = 408;
        res.setHeader('Connection', 'close');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.once('finish', () => req.destroy());
        res.end(
          JSON.stringify({
            statusCode: 408,
            error: 'Request Timeout',
            message: UPLOAD_TIMEOUT_MESSAGE,
          }),
        );
      } else {
        req.destroy();
      }
      // La plaza se libera ya, aunque el socket tarde en cerrarse.
      release();
    };
    req.setTimeout(this.slots.timeouts.idleTimeoutMs, expire);
    const deadline = setTimeout(expire, this.slots.timeouts.maxDurationMs);
    res.once('close', () => {
      clearTimeout(deadline);
      release();
      void removeLocalFile(req.file?.path).catch(() => undefined);
    });
    return true;
  }
}
