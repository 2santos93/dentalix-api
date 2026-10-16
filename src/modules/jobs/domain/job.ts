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
}

export interface EnqueueOptions {
  /** Cuándo puede empezar (default: ya). */
  runAt?: Date;
  /**
   * Clave de idempotencia global: un segundo enqueue con la misma clave no
   * crea otro trabajo (aunque el primero ya terminara), mientras la fila
   * exista (los terminados se purgan a los JOBS_RETENTION_DAYS).
   */
  idempotencyKey?: string;
  /**
   * Clínica bajo la que corre el handler. Default: la de la transacción
   * (`app.current_tenant` de `runWithTenant`) si se encola dentro de una; si
   * no, ninguna (trabajo de plataforma).
   */
  tenantId?: string | null;
  /**
   * Transacción de negocio (outbox): el trabajo solo existe si ella hace
   * commit. Sin ella, se encola en su propia sentencia.
   */
  tx?: Prisma.TransactionClient;
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

export const JOB_NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const JOB_NAME_MAX_LENGTH = 80;
export const MAX_ATTEMPTS_LIMIT = 25;
