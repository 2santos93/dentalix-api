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

/** Por qué no hay plaza: la réplica está llena o la clave ya tiene las suyas. */
export type SlotBusy = 'replica' | 'key';

export type SlotAcquisition = { release: () => void } | { busy: SlotBusy };

/**
 * DX-259 (OPS-038): semáforo de las subidas que pasan por la API en esta
 * réplica (`UPLOAD_MAX_CONCURRENCY`, por defecto 4). No hay cola: sin plaza,
 * 503 con `Retry-After` al momento, antes de leer el cuerpo.
 *
 * SEC-046: con `perKeyCapacity`, además, como mucho esas plazas por clave
 * (la clínica, en la lectura de ficheros de importación). Sin clave solo
 * cuenta el tope de la réplica.
 */
export class UploadSlots {
  private inUse = 0;
  private readonly perKey = new Map<string, number>();

  constructor(
    readonly capacity: number,
    readonly timeouts: UploadTimeouts = DEFAULT_UPLOAD_TIMEOUTS,
    readonly perKeyCapacity: number = Number.POSITIVE_INFINITY,
  ) {}

  get active(): number {
    return this.inUse;
  }

  /** Plazas en uso de una clave. */
  activeFor(key: string): number {
    return this.perKey.get(key) ?? 0;
  }

  /** Claves con alguna plaza en uso (una clave sin plazas no se guarda). */
  get trackedKeys(): number {
    return this.perKey.size;
  }

  /** Una plaza y la función que la devuelve (idempotente), o null si no hay. */
  tryAcquire(key?: string): (() => void) | null {
    const got = this.acquire(key);
    return 'release' in got ? got.release : null;
  }

  /** Como `tryAcquire`, pero sin plaza dice por qué. */
  acquire(key?: string): SlotAcquisition {
    if (key !== undefined && this.activeFor(key) >= this.perKeyCapacity) {
      return { busy: 'key' };
    }
    if (this.inUse >= this.capacity) return { busy: 'replica' };
    this.inUse += 1;
    if (key !== undefined) this.perKey.set(key, this.activeFor(key) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inUse -= 1;
        if (key === undefined) return;
        const left = this.activeFor(key) - 1;
        if (left > 0) this.perKey.set(key, left);
        // eslint-disable-next-line no-restricted-syntax -- un Map en memoria, no un dato de la BD
        else this.perKey.delete(key);
      },
    };
  }
}

/** Lo que un guard de plazas puede mirar de la petición para su clave. */
export interface SlotRequest {
  user?: { tenantId?: string };
}

interface UploadRequest extends SlotRequest {
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
 *
 * Base común: `UploadSlotGuard` (subidas, DX-259) y `ImportReadSlotGuard`
 * (lectura de ficheros de importación, SEC-046), cada uno con su semáforo.
 */
export abstract class SlotGuard implements CanActivate {
  protected abstract readonly slots: UploadSlots;

  /** Clave del tope por clave (SEC-046); sin ella, solo el de la réplica. */
  protected keyOf(_req: SlotRequest): string | undefined {
    return undefined;
  }

  /** Mensaje del 503 cuando no hay plaza. */
  protected busyMessage(_busy: SlotBusy): string {
    return UPLOAD_BUSY_MESSAGE;
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<UploadRequest>();
    const res = http.getResponse<UploadResponse>();
    const got = this.slots.acquire(this.keyOf(req));
    if ('busy' in got) {
      res.setHeader('Retry-After', String(UPLOAD_BUSY_RETRY_AFTER_SECONDS));
      throw new ServiceUnavailableException(this.busyMessage(got.busy));
    }
    const { release } = got;
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

/** DX-259: plazas de las subidas que pasan por la API (`UPLOAD_SLOTS`). */
@Injectable()
export class UploadSlotGuard extends SlotGuard {
  constructor(@Inject(UPLOAD_SLOTS) protected readonly slots: UploadSlots) {
    super();
  }
}

/**
 * Pareja de los guards de plazas (`SlotGuard`): va el PRIMERO en `@UseInterceptors`, antes de
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
