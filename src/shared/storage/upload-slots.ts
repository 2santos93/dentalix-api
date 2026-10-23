import {
  CallHandler,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
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
  /** true cuando Node ya recibió el cuerpo entero. */
  complete?: boolean;
  setTimeout(ms: number, callback?: () => void): unknown;
  once(event: 'end', listener: () => void): unknown;
  destroy(): unknown;
  [UPLOAD_LEASE]?: UploadLease;
}

interface UploadResponse {
  headersSent: boolean;
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
  once(event: 'close' | 'finish', listener: () => void): unknown;
}

const UPLOAD_LEASE = Symbol('UPLOAD_LEASE');

/** La plaza de una subida en curso, colgada de la petición. */
interface UploadLease {
  /** El interceptor tomó la subida: él la cierra al terminar el handler. */
  handled: boolean;
  /** Devuelve la plaza y borra el temporal de multer (idempotente). */
  finish(): void;
}

/**
 * Guard de las rutas que reciben un fichero (va DESPUÉS de la autenticación y
 * ANTES de multer, que corre en un interceptor): reserva una plaza o responde
 * 503 sin leer el cuerpo.
 *
 * Los plazos (`UploadTimeouts`) cubren SOLO la lectura del cuerpo: al vencer
 * responde 408 y corta. En cuanto Node tiene el cuerpo entero se desarman
 * (revisión I-1): Node solo avisa del `'timeout'` mientras lee el cuerpo y,
 * después, destruiría el socket a mitad del procesamiento (hash, S3, BD).
 *
 * La plaza y el temporal se devuelven cuando TERMINA el handler
 * (`UploadSlotInterceptor`, con `finalize`), no al cerrarse la respuesta: un
 * cliente que se va no libera la plaza de una subida que sigue procesándose.
 * Si el interceptor no llegó a correr (otro guard o interceptor falló antes),
 * se devuelven al cerrarse la respuesta.
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
    const lease: UploadLease = {
      handled: false,
      finish: () => {
        disarm();
        release();
        void removeLocalFile(req.file?.path).catch(() => undefined);
      },
    };
    req[UPLOAD_LEASE] = lease;
    const expire = () => {
      // Con el cuerpo ya recibido no hay nada que cortar: el handler manda.
      if (req.complete) return;
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
      // El cuerpo no llegó entero, así que el handler no correrá con él: la
      // plaza se libera ya, aunque el socket tarde en cerrarse.
      release();
    };
    const deadline = setTimeout(expire, this.slots.timeouts.maxDurationMs);
    const disarm = () => {
      clearTimeout(deadline);
      req.setTimeout(0);
    };
    req.setTimeout(this.slots.timeouts.idleTimeoutMs, expire);
    req.once('end', disarm);
    res.once('close', () => {
      disarm();
      if (!lease.handled) lease.finish();
    });
    return true;
  }
}

/**
 * Pareja de `UploadSlotGuard`: va el PRIMERO en `@UseInterceptors`, antes de
 * multer, y devuelve la plaza y borra el temporal cuando el handler termina
 * (bien, con error o porque multer falló al leer el cuerpo).
 */
@Injectable()
export class UploadSlotInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const lease = context.switchToHttp().getRequest<UploadRequest>()[
      UPLOAD_LEASE
    ];
    if (!lease) return next.handle();
    lease.handled = true;
    return next.handle().pipe(finalize(() => lease.finish()));
  }
}
