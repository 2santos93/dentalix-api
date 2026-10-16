import type { Prisma } from '@prisma/client';
import type { ClaimedJob, EnqueueResult, FailedJob, JobPayload } from './job';

export const JOB_REPOSITORY = Symbol('JOB_REPOSITORY');

export interface NewJob {
  name: string;
  payload: JobPayload;
  /** Ya resuelta por JobQueue: null = plataforma. */
  tenantId: string | null;
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts: number;
}

export interface ScheduleSync {
  name: string;
  cron: string;
  /** Primer tick posterior a `now` (hora de la BD). */
  firstRunAfter: (now: Date) => Date;
}

export interface ScheduleToFire {
  name: string;
  /** Cron de esta réplica: solo dispara si coincide con el de la fila. */
  cron: string;
  job: string;
  payload: JobPayload;
  maxAttempts: number;
  /** Próximo tick posterior a `now` (hora de la BD). */
  nextRunAfter: (now: Date) => Date;
}

/** Persistencia de la cola (DX-085). Ver PrismaJobRepository. */
export interface JobRepository {
  /**
   * INSERT … ON CONFLICT (tenantId, idempotencyKey) DO NOTHING, en `tx` si se
   * da. En conflicto devuelve el trabajo existente DE ESA MISMA clínica.
   */
  insert(job: NewJob, tx?: Prisma.TransactionClient): Promise<EnqueueResult>;
  /** `app.current_tenant` de la transacción (null si no lo fija). */
  transactionTenant(tx: Prisma.TransactionClient): Promise<string | null>;
  /**
   * Latido: renueva el arriendo `leaseSeconds` más SOLO si el trabajo sigue
   * RUNNING en ese intento (fencing). false = otro worker lo retomó.
   */
  heartbeat(
    id: string,
    attempts: number,
    leaseSeconds: number,
  ): Promise<boolean>;
  /**
   * Reclama hasta `limit` trabajos vencidos con esos nombres (FOR UPDATE SKIP
   * LOCKED): RUNNING, intento + 1 y arriendo de `leaseSeconds`.
   */
  claim(
    names: string[],
    limit: number,
    leaseSeconds: number,
    workerId: string,
  ): Promise<ClaimedJob[]>;
  /** Cierres con fencing: solo si sigue RUNNING en ESE intento. */
  complete(id: string, attempts: number): Promise<boolean>;
  reschedule(
    id: string,
    attempts: number,
    delayMs: number,
    lastError: string,
  ): Promise<boolean>;
  fail(id: string, attempts: number, lastError: string): Promise<boolean>;
  /** Crea las tareas que falten y reprograma las que cambiaron de cron. */
  syncSchedules(schedules: ScheduleSync[]): Promise<void>;
  /**
   * Un solo worker por tick: bloquea las tareas vencidas (SKIP LOCKED), encola
   * su trabajo con idempotencyKey `schedule:<nombre>:<tick>` y las mueve al
   * siguiente tick, todo en una transacción. Una tarea cuyo cron en la BD no
   * es el de esta réplica (despliegue escalonado) no la toca: la dispara la
   * réplica que la sincronizó. Devuelve cuántas disparó.
   */
  fireDueSchedules(schedules: ScheduleToFire[]): Promise<number>;
  listFailed(limit: number): Promise<FailedJob[]>;
  /** Borra COMPLETED y FAILED terminados antes de `before`. */
  purgeFinished(before: Date): Promise<number>;
}
