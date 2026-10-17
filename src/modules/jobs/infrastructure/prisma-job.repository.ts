import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  WORKER_ALIVE_SECONDS,
  type ClaimedJob,
  type EnqueueResult,
  type ExhaustedJob,
  type FailedJob,
  type JobPayload,
  type JobState,
  type PlatformActor,
  type QueueSnapshot,
  type RetryResult,
  type WorkerBeat,
  type WorkerRow,
} from '../domain/job';
import type {
  JobRepository,
  NewJob,
  ScheduleSync,
  ScheduleToFire,
} from '../domain/job-repository.port';

/** Hora UTC de la BD: las columnas son `timestamp(3)` sin zona, en UTC. */
const NOW = Prisma.sql`timezone('utc', now())`;

/** Un instante JS como `timestamp` UTC, sin depender del TimeZone de la sesión. */
const utc = (date: Date): Prisma.Sql =>
  Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

const PURGE_BATCH = 1000;
/** Workers que lista `snapshot` (los de latido más reciente). */
const SNAPSHOT_WORKERS = 50;

/**
 * Cola de trabajos en Postgres (DX-085). `jobs` y `job_schedules` son tablas
 * de PLATAFORMA sin RLS: se tocan con el cliente base (o con la transacción
 * de negocio que encola), nunca dentro de `runWithTenant` salvo para encolar.
 * Todo el reclamo y los cierres son SQL crudo para controlar el candado
 * (`FOR UPDATE SKIP LOCKED`) y el fencing por intento.
 */
@Injectable()
export class PrismaJobRepository implements JobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(
    job: NewJob,
    tx?: Prisma.TransactionClient,
  ): Promise<EnqueueResult> {
    const client = tx ?? this.prisma;
    const runAt = job.runAt ? utc(job.runAt) : NOW;
    const key = job.idempotencyKey ?? null;
    // Inferencia del índice parcial jobs_tenantId_idempotencyKey_key
    // ((tenantId, idempotencyKey) NULLS NOT DISTINCT WHERE key IS NOT NULL).
    const inserted = await client.$queryRaw<{ id: string }[]>`
      INSERT INTO "jobs"
        ("name", "tenantId", "payload", "maxAttempts", "runAt", "idempotencyKey")
      VALUES
        (${job.name}, ${job.tenantId}::uuid, ${JSON.stringify(job.payload)}::jsonb,
         ${job.maxAttempts}, ${runAt}, ${key})
      ON CONFLICT ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL
      DO NOTHING
      RETURNING "id"`;
    if (inserted.length > 0) {
      return { id: inserted[0].id, created: true };
    }
    // Conflicto: otra transacción de la MISMA clínica ya lo encoló (o lo hizo
    // y ya terminó). Una sentencia NUEVA, para ver la fila que acaba de
    // confirmarse (READ COMMITTED).
    const [existing] = await client.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "jobs"
       WHERE "tenantId" IS NOT DISTINCT FROM ${job.tenantId}::uuid
         AND "idempotencyKey" = ${key}`;
    if (!existing) {
      throw new Error(
        'jobs: conflicto de idempotencyKey sin fila visible (se borró entretanto, o la transacción no es READ COMMITTED)',
      );
    }
    return { id: existing.id, created: false };
  }

  async transactionTenant(
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const [{ tenant }] = await tx.$queryRaw<{ tenant: string | null }[]>`
      SELECT NULLIF(current_setting('app.current_tenant', true), '') AS "tenant"`;
    return tenant;
  }

  async heartbeat(
    id: string,
    attempts: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "jobs"
         SET "runAt" = ${NOW} + make_interval(secs => ${leaseSeconds}::double precision),
             "updatedAt" = ${NOW}
       WHERE "id" = ${id}::uuid AND "state" = 'RUNNING' AND "attempts" = ${attempts}`;
    return n > 0;
  }

  claim(
    names: string[],
    limit: number,
    leaseSeconds: number,
    workerId: string,
  ): Promise<ClaimedJob[]> {
    if (names.length === 0 || limit <= 0) {
      return Promise.resolve([]);
    }
    // RUNNING con `runAt` vencido = arriendo vencido (el worker murió): se
    // retoma. Índice (state, runAt). DX-220 (OPS-030): nunca una fila con
    // `attempts > maxAttempts` (la deja `maxAttempts + 1` un cierre que no
    // llegó a hacerse): sumarle uno violaría jobs_attempts_check y, como el
    // lote es UNA sentencia, pararía la cola entera en cada vuelta. Esas
    // filas las cierra failExhausted.
    return this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "jobs" AS j
         SET "state" = 'RUNNING',
             "attempts" = j."attempts" + 1,
             "lockedBy" = ${workerId},
             "runAt" = ${NOW} + make_interval(secs => ${leaseSeconds}::double precision),
             "updatedAt" = ${NOW}
       WHERE j."id" IN (
         SELECT c."id" FROM "jobs" AS c
          WHERE c."state" IN ('PENDING', 'RUNNING')
            AND c."runAt" <= ${NOW}
            AND c."name" = ANY(${names}::text[])
            AND c."attempts" <= c."maxAttempts"
          ORDER BY c."runAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING j."id", j."name", j."tenantId", j."payload", j."attempts",
                j."maxAttempts"`;
  }

  failExhausted(limit: number): Promise<ExhaustedJob[]> {
    // Sin fencing por intento: la fila ya no tiene dueño (arriendo vencido) y
    // SKIP LOCKED la salta si otro worker la está cerrando ahora mismo.
    return this.prisma.$queryRaw<ExhaustedJob[]>`
      UPDATE "jobs" AS j
         SET "state" = 'FAILED', "finishedAt" = ${NOW},
             "lastError" = 'LeaseExpired', "lockedBy" = NULL,
             "updatedAt" = ${NOW}
       WHERE j."id" IN (
         SELECT c."id" FROM "jobs" AS c
          WHERE c."state" = 'RUNNING'
            AND c."runAt" <= ${NOW}
            AND c."attempts" >= c."maxAttempts"
          ORDER BY c."runAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING j."id", j."name", j."tenantId", j."attempts"`;
  }

  async complete(id: string, attempts: number): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "jobs"
         SET "state" = 'COMPLETED', "finishedAt" = ${NOW}, "lockedBy" = NULL,
             "lastError" = NULL, "updatedAt" = ${NOW}
       WHERE "id" = ${id}::uuid AND "state" = 'RUNNING' AND "attempts" = ${attempts}`;
    return n > 0;
  }

  async reschedule(
    id: string,
    attempts: number,
    delayMs: number,
    lastError: string,
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "jobs"
         SET "state" = 'PENDING',
             "runAt" = ${NOW} + make_interval(secs => ${delayMs / 1000}::double precision),
             "lastError" = left(${lastError}, 200), "lockedBy" = NULL,
             "updatedAt" = ${NOW}
       WHERE "id" = ${id}::uuid AND "state" = 'RUNNING' AND "attempts" = ${attempts}`;
    return n > 0;
  }

  async fail(
    id: string,
    attempts: number,
    lastError: string,
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "jobs"
         SET "state" = 'FAILED', "finishedAt" = ${NOW},
             "lastError" = left(${lastError}, 200), "lockedBy" = NULL,
             "updatedAt" = ${NOW}
       WHERE "id" = ${id}::uuid AND "state" = 'RUNNING' AND "attempts" = ${attempts}`;
    return n > 0;
  }

  private async dbNow(): Promise<Date> {
    const [{ now }] = await this.prisma.$queryRaw<{ now: Date }[]>`
      SELECT ${NOW} AS "now"`;
    return now;
  }

  async syncSchedules(schedules: ScheduleSync[]): Promise<void> {
    if (schedules.length === 0) return;
    const now = await this.dbNow();
    for (const s of schedules) {
      // Solo cambia algo si la tarea es nueva o su cron cambió: varios workers
      // arrancando a la vez no se pisan el próximo tick.
      await this.prisma.$executeRaw`
        INSERT INTO "job_schedules" ("name", "cron", "nextRunAt", "updatedAt")
        VALUES (${s.name}, ${s.cron}, ${utc(s.firstRunAfter(now))}, ${NOW})
        ON CONFLICT ("name") DO UPDATE
           SET "cron" = EXCLUDED."cron", "nextRunAt" = EXCLUDED."nextRunAt",
               "updatedAt" = EXCLUDED."updatedAt"
         WHERE "job_schedules"."cron" IS DISTINCT FROM EXCLUDED."cron"`;
    }
  }

  fireDueSchedules(schedules: ScheduleToFire[]): Promise<number> {
    if (schedules.length === 0) return Promise.resolve(0);
    const byName = new Map(schedules.map((s) => [s.name, s]));
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<
        { name: string; cron: string; nextRunAt: Date; now: Date }[]
      >`
        SELECT "name", "cron", "nextRunAt", ${NOW} AS "now"
          FROM "job_schedules"
         WHERE "name" = ANY(${[...byName.keys()]}::text[])
           AND "nextRunAt" <= ${NOW}
         FOR UPDATE SKIP LOCKED`;
      let fired = 0;
      for (const row of due) {
        const s = byName.get(row.name);
        // Despliegue escalonado: la fila tiene el cron de otra réplica (la que
        // sincronizó la versión vigente). Esta no la dispara ni la reprograma.
        if (!s || s.cron !== row.cron) continue;
        fired += 1;
        // La clave por tick es la segunda red: aunque dos workers llegaran
        // a disparar el mismo tick, solo habría un trabajo.
        await this.insert(
          {
            name: s.job,
            payload: s.payload,
            tenantId: null,
            maxAttempts: s.maxAttempts,
            idempotencyKey: `schedule:${s.name}:${row.nextRunAt.toISOString()}`,
          },
          tx,
        );
        // Un worker caído durante varios ticks no los recupera todos: corre
        // una vez y sigue desde ahora.
        await tx.$executeRaw`
          UPDATE "job_schedules"
             SET "lastRunAt" = "nextRunAt",
                 "nextRunAt" = ${utc(s.nextRunAfter(row.now))},
                 "updatedAt" = ${NOW}
           WHERE "name" = ${s.name}`;
      }
      return fired;
    });
  }

  async listFailed(limit: number): Promise<FailedJob[]> {
    const rows = await this.prisma.job.findMany({
      where: { state: 'FAILED' },
      orderBy: { finishedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        name: true,
        tenantId: true,
        payload: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        createdAt: true,
        finishedAt: true,
      },
    });
    return rows.map((row) => ({ ...row, payload: row.payload as JobPayload }));
  }

  async purgeFinished(before: Date): Promise<number> {
    // Borrado duro legítimo (housekeeping con TTL): un trabajo terminado no
    // es dato de negocio. Por tandas para no bloquear la tabla.
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM "jobs"
         WHERE "id" IN (
           SELECT "id" FROM "jobs"
            WHERE "state" IN ('COMPLETED', 'FAILED')
              AND "finishedAt" < ${utc(before)}
            LIMIT ${PURGE_BATCH}
         )`;
      total += n;
      if (n < PURGE_BATCH) return total;
    }
  }

  async beat(worker: WorkerBeat): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "job_workers" ("id", "role", "version", "startedAt", "lastBeatAt")
      VALUES (${worker.id}, ${worker.role}, ${worker.version}, ${NOW}, ${NOW})
      ON CONFLICT ("id") DO UPDATE
         SET "lastBeatAt" = EXCLUDED."lastBeatAt",
             "version" = EXCLUDED."version"`;
  }

  purgeStaleWorkers(before: Date): Promise<number> {
    // Borrado duro legítimo (housekeeping): un latido viejo no es dato.
    return this.prisma.$executeRaw`
      DELETE FROM "job_workers" WHERE "lastBeatAt" < ${utc(before)}`;
  }

  async statementTimeoutMs(): Promise<number> {
    // current_setting lo da con unidad ('0', '30s', '5min'): como interval.
    const [{ ms }] = await this.prisma.$queryRaw<{ ms: number }[]>`
      SELECT (EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval)
              * 1000)::float8 AS "ms"`;
    return Math.max(0, Math.round(ms));
  }

  async snapshot(): Promise<QueueSnapshot> {
    // Tres lecturas por índice, no un recorrido de la tabla: los terminados
    // (14 días de COMPLETED) no se tocan. (state, runAt) para PENDING y
    // RUNNING; (state, finishedAt) para los FAILED de 24 h.
    const [queue] = await this.prisma.$queryRaw<
      {
        now: Date;
        pendingDue: number;
        pendingScheduled: number;
        oldestDueRunAt: Date | null;
        running: number;
        runningExpired: number;
      }[]
    >`
      SELECT ${NOW} AS "now",
             (count(*) FILTER (WHERE "state" = 'PENDING' AND "runAt" <= ${NOW}))::int AS "pendingDue",
             (count(*) FILTER (WHERE "state" = 'PENDING' AND "runAt" > ${NOW}))::int AS "pendingScheduled",
             min("runAt") FILTER (WHERE "state" = 'PENDING' AND "runAt" <= ${NOW}) AS "oldestDueRunAt",
             (count(*) FILTER (WHERE "state" = 'RUNNING'))::int AS "running",
             (count(*) FILTER (WHERE "state" = 'RUNNING' AND "runAt" <= ${NOW}))::int AS "runningExpired"
        FROM "jobs"
       WHERE "state" IN ('PENDING', 'RUNNING')`;
    const [{ failedLast24h }] = await this.prisma.$queryRaw<
      { failedLast24h: number }[]
    >`
      SELECT count(*)::int AS "failedLast24h"
        FROM "jobs"
       WHERE "state" = 'FAILED'
         AND "finishedAt" >= ${NOW} - interval '24 hours'`;
    const workers = await this.prisma.$queryRaw<WorkerRow[]>`
      SELECT "id", "role", "version", "startedAt", "lastBeatAt",
             "lastBeatAt" > ${NOW} - make_interval(secs => ${WORKER_ALIVE_SECONDS}) AS "alive"
        FROM "job_workers"
       ORDER BY "lastBeatAt" DESC
       LIMIT ${SNAPSHOT_WORKERS}`;
    const schedules = await this.prisma.jobSchedule.findMany({
      select: { name: true, cron: true, lastRunAt: true, nextRunAt: true },
      orderBy: { name: 'asc' },
    });
    return { ...queue, failedLast24h, workers, schedules };
  }

  retryFailed(id: string, actor: PlatformActor): Promise<RetryResult> {
    return this.prisma.$transaction(async (tx): Promise<RetryResult> => {
      // FOR UPDATE: dos reintentos a la vez se ponen en fila y el segundo
      // ya lo ve PENDING (not_failed): se reencola una sola vez.
      const [row] = await tx.$queryRaw<
        {
          id: string;
          name: string;
          tenantId: string | null;
          state: JobState;
          attempts: number;
          lastError: string | null;
        }[]
      >`
        SELECT "id", "name", "tenantId", "state", "attempts", "lastError"
          FROM "jobs" WHERE "id" = ${id}::uuid
         FOR UPDATE`;
      if (!row) return { status: 'not_found' };
      if (row.state !== 'FAILED') {
        return { status: 'not_failed', state: row.state };
      }
      // La fila conserva su idempotencyKey: el índice único
      // (tenantId, idempotencyKey) ya garantiza que ninguna otra la tiene,
      // así que reencolarla no duplica el trabajo. lastError se queda como
      // pista hasta el próximo cierre.
      await tx.$executeRaw`
        UPDATE "jobs"
           SET "state" = 'PENDING', "attempts" = 0, "runAt" = ${NOW},
               "finishedAt" = NULL, "lockedBy" = NULL, "updatedAt" = ${NOW}
         WHERE "id" = ${id}::uuid`;
      // Sin el payload: nombre, clínica, intentos y tipo de error.
      const metadata = {
        jobName: row.name,
        tenantId: row.tenantId,
        previousAttempts: row.attempts,
        lastError: row.lastError,
      };
      await tx.$executeRaw`
        INSERT INTO "platform_audit_events"
          ("actorUserId", "action", "resourceType", "resourceId", "requestId",
           "ip", "userAgent", "metadata", "occurredAt")
        VALUES
          (${actor.userId}::uuid, 'JOB_RETRIED', 'JOB', ${id}::uuid,
           left(${actor.requestId}, 200), left(${actor.ip}, 64),
           left(${actor.userAgent}, 512),
           ${JSON.stringify(metadata)}::jsonb, ${NOW})`;
      return {
        status: 'retried',
        job: {
          id: row.id,
          name: row.name,
          tenantId: row.tenantId,
          previousAttempts: row.attempts,
          lastError: row.lastError,
        },
      };
    });
  }
}
