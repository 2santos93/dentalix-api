import { Logger, type LoggerService } from '@nestjs/common';

/**
 * DX-259 (OPS-039): una línea `storage.op` por operación contra el almacén,
 * con su duración y su resultado, para ver la latencia y los errores de S3
 * (y del disco en desarrollo) en el log.
 *
 * Solo campos de esta lista cerrada: NUNCA la clave (lleva tenant e ids), el
 * nombre del fichero, la URL ni nada del paciente; del error, solo su tipo.
 */
export const STORAGE_OPS = [
  'put',
  'get',
  'range',
  'head',
  'copy',
  'delete',
  'head-bucket',
] as const;
export type StorageOp = (typeof STORAGE_OPS)[number];

export type StorageOutcome =
  | 'ok'
  | 'not_found'
  | 'precondition_failed'
  | 'timeout'
  | 'unavailable'
  | 'error';

export interface StorageOpRecord {
  driver: 's3' | 'disk';
  op: StorageOp;
  outcome: StorageOutcome;
  durationMs: number;
  /** Bytes subidos o leídos, si se conocen (no identifica a nadie). */
  bytes?: number;
  /** Tipo del error (`TimeoutError`, `AccessDenied`…), nunca su mensaje. */
  error?: string;
}

/** Nombre del error sin su mensaje; `NonError` si no es un Error. */
export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  return 'NonError';
}

export class StorageOpLogger {
  constructor(
    private readonly logger: Pick<LoggerService, 'log' | 'warn'> = new Logger(
      'Storage',
    ),
  ) {}

  /** `ok` y `not_found` son normales (info); el resto, warn. */
  record(entry: StorageOpRecord): void {
    // Se copia campo a campo: nada que no esté en StorageOpRecord sale al log.
    const fields: Record<string, unknown> = {
      event: 'storage.op',
      driver: entry.driver,
      op: entry.op,
      outcome: entry.outcome,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
    if (entry.outcome === 'ok' || entry.outcome === 'not_found') {
      this.logger.log(fields);
    } else {
      this.logger.warn(fields);
    }
  }

  /** Mide `fn` y deja su línea; `classify` decide el resultado de un error. */
  async time<T>(
    driver: 's3' | 'disk',
    op: StorageOp,
    fn: () => Promise<T>,
    classify: (err: unknown) => StorageOutcome,
    bytes?: (result: T) => number | undefined,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await fn();
      this.record({
        driver,
        op,
        outcome: 'ok',
        durationMs: performance.now() - started,
        bytes: bytes?.(result),
      });
      return result;
    } catch (err) {
      const outcome = classify(err);
      this.record({
        driver,
        op,
        outcome,
        durationMs: performance.now() - started,
        ...(outcome === 'not_found' ? {} : { error: errorName(err) }),
      });
      throw err;
    }
  }
}
