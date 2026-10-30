import type { Prisma } from '@prisma/client';

/**
 * Payload de un trabajo: SOLO ids y valores técnicos (fechas, códigos), nunca
 * datos del paciente (nombre, email, teléfono, texto clínico). El handler
 * vuelve a leer lo que necesite de la BD bajo el tenant del trabajo. La tabla
 * lo acota a 4 KB (CHECK) para que nadie meta un documento.
 */
export type JobPayload = Record<string, Prisma.InputJsonValue | null>;

/** Lo que recibe un handler además del payload. */
export interface JobContext {
  jobId: string;
  /** Intento en curso: 1 la primera vez. */
  attempt: number;
  maxAttempts: number;
  /**
   * Clínica del trabajo, o null si es de plataforma. Si no es null el handler
   * ya corre con ese tenant en `TenantContextService`: `runWithTenant(fn)` sin
   * tenant explícito lo usa.
   */
  tenantId: string | null;
  /**
   * Se aborta si este worker pierde el intento (el latido no pudo renovar el
   * arriendo porque otro worker lo retomó) o si el apagado agota su gracia.
   * Un handler largo debe consultarla y dejar de producir efectos: su
   * resultado ya no cuenta.
   */
  signal: AbortSignal;
}

export type JobHandler<P extends JobPayload = JobPayload> = (
  payload: P,
  context: JobContext,
) => Promise<void>;

export interface JobDefinition<P extends JobPayload = JobPayload> {
  /** `modulo.trabajo` en minúsculas (p. ej. `auth.purge-expired-tokens`). */
  name: string;
  handle: JobHandler<P>;
  /** Intentos totales antes de quedar FAILED (1..25). Default: JOBS_MAX_ATTEMPTS. */
  maxAttempts?: number;
  /** Base del backoff exponencial. Default: JOBS_RETRY_BASE_MS. */
  retryBaseMs?: number;
}

export interface ScheduleDefinition {
  /** Nombre único de la tarea programada (p. ej. `auth.purge-expired-tokens.hourly`). */
  name: string;
  /** Cron de 5 campos en UTC (ver cron.ts). */
  cron: string;
  /** Trabajo registrado que encola en cada tick. */
  job: string;
  payload?: JobPayload;
  /**
   * DX-380 (OPS-046): una sola ejecución a la vez. Si el trabajo de un tick
   * anterior de ESTA tarea sigue en PENDING o RUNNING, el tick se salta (se
   * reprograma al siguiente sin encolar nada), queda en el log
   * (`jobs.schedule_skipped`) y en `stats`. Para los barridos, que recorren
   * todas las clínicas y pueden tardar más que su periodo. Default: false.
   */
  singleton?: boolean;
}

export interface EnqueueOptions {
  /** Cuándo puede empezar (default: ya). */
  runAt?: Date;
  /**
   * Clave de idempotencia POR CLÍNICA (o de plataforma): un segundo enqueue
   * con la misma clave en la misma clínica no crea otro trabajo (aunque el
   * primero ya terminara), mientras la fila exista (los terminados se purgan
   * a los JOBS_RETENTION_DAYS).
   */
  idempotencyKey?: string;
  /**
   * Clínica bajo la que corre el handler (null = plataforma). Default: la del
   * contexto (`TenantContextService`) o, si no hay, la de la transacción
   * (`app.current_tenant` de `runWithTenant`); sin ninguna, plataforma. Si se
   * da y no coincide con el contexto o con la transacción, es un error.
   */
  tenantId?: string | null;
  /**
   * Transacción de negocio (outbox): el trabajo solo existe si ella hace
   * commit. Con contexto de clínica es OBLIGATORIA salvo
   * `outsideTransaction: true`. Exige READ COMMITTED (el default): en
   * REPEATABLE READ un conflicto de idempotencyKey con una fila confirmada
   * después del snapshot no se puede releer.
   */
  tx?: Prisma.TransactionClient;
  /**
   * Encolar con contexto de clínica pero SIN transacción de negocio, a
   * propósito (no hay nada que confirmar junto al trabajo).
   */
  outsideTransaction?: boolean;
  maxAttempts?: number;
}

export interface EnqueueResult {
  id: string;
  /** false si ya existía un trabajo con la misma idempotencyKey. */
  created: boolean;
}

export type JobState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/** Un trabajo reclamado por un worker (ya en RUNNING y con el intento sumado). */
export interface ClaimedJob {
  id: string;
  name: string;
  tenantId: string | null;
  payload: JobPayload;
  attempts: number;
  maxAttempts: number;
}

/** Fila de la cola de fallidos (endpoint de plataforma). */
export interface FailedJob {
  id: string;
  name: string;
  tenantId: string | null;
  payload: JobPayload;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Trabajo que `failExhausted` cerró como FAILED `LeaseExpired` (DX-220). */
export interface ExhaustedJob {
  id: string;
  name: string;
  tenantId: string | null;
  attempts: number;
}

/** Latido de un proceso worker (`job_workers`, DX-220). */
export interface WorkerBeat {
  id: string;
  role: 'worker' | 'all';
  /** APP_VERSION del proceso, o null. */
  version: string | null;
}

/** Fila de `job_workers` tal como la ve `GET /platform/jobs/stats`. */
export interface WorkerRow extends WorkerBeat {
  startedAt: Date;
  lastBeatAt: Date;
  /** Latió hace menos de WORKER_ALIVE_SECONDS. */
  alive: boolean;
}

/** Lo que `stats` lee de la BD; JobsAdmin le añade el estado de cada tarea. */
export interface QueueSnapshot {
  /** Hora de la BD (UTC) a la que se tomó. */
  now: Date;
  /** PENDING cuya hora ya llegó: lo que espera a un worker. */
  pendingDue: number;
  /** PENDING programados para más adelante (recordatorios, reintentos). */
  pendingScheduled: number;
  /** `min(runAt)` de los PENDING vencidos, o null si no hay. */
  oldestDueRunAt: Date | null;
  running: number;
  /** RUNNING con el arriendo vencido (su worker murió o no late). */
  runningExpired: number;
  failedLast24h: number;
  workers: WorkerRow[];
  schedules: {
    name: string;
    cron: string;
    lastRunAt: Date | null;
    nextRunAt: Date;
    /** DX-380: ticks saltados por `singleton` desde que existe la tarea. */
    skippedCount: number;
    /** DX-380: el último tick saltado, o null. */
    lastSkippedAt: Date | null;
  }[];
}

/** Quién reencola un trabajo y desde dónde (auditoría de plataforma). */
export interface PlatformActor {
  userId: string;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Resultado de reencolar un FAILED (sin el payload). */
export type RetryResult =
  | {
      status: 'retried';
      job: {
        id: string;
        name: string;
        tenantId: string | null;
        /** Intentos que llevaba al fallar (ahora vuelve a 0). */
        previousAttempts: number;
        lastError: string | null;
      };
    }
  | { status: 'not_found' }
  /** Ya no está FAILED: se reencoló antes (o nunca falló). */
  | { status: 'not_failed'; state: JobState };

/** Un worker cuenta como vivo si latió hace menos de esto. */
export const WORKER_ALIVE_SECONDS = 60;
/** Días sin latir tras los que la purga diaria borra la fila del worker. */
export const WORKER_RETENTION_DAYS = 7;

export const JOB_NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const JOB_NAME_MAX_LENGTH = 80;
export const MAX_ATTEMPTS_LIMIT = 25;
