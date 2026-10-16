import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type {
  ClaimedJob,
  EnqueueResult,
  FailedJob,
  JobPayload,
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
    // Sin tenant explícito: el de la transacción de negocio (runWithTenant lo
    // fija con set_config local; fuera de una transacción vale '' -> NULL).
    const tenant =
      job.tenantId === undefined
        ? Prisma.sql`NULLIF(current_setting('app.current_tenant', true), '')::uuid`
        : Prisma.sql`${job.tenantId}::uuid`;
    const runAt = job.runAt ? utc(job.runAt) : NOW;
    const key = job.idempotencyKey ?? null;
    const inserted = await client.$queryRaw<{ id: string }[]>`
      INSERT INTO "jobs"
        ("name", "tenantId", "payload", "maxAttempts", "runAt", "idempotencyKey")
      VALUES
        (${job.name}, ${tenant}, ${JSON.stringify(job.payload)}::jsonb,
         ${job.maxAttempts}, ${runAt}, ${key})
      ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING "id"`;
    if (inserted.length > 0) {
      return { id: inserted[0].id, created: true };
    }
    // Conflicto: otra transacción ya lo encoló (o lo hizo y ya terminó). Una
    // sentencia NUEVA, para ver la fila que acaba de confirmarse.
    const [existing] = await client.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "jobs" WHERE "idempotencyKey" = ${key}`;
    if (!existing) {
      throw new Error(
        'jobs: conflicto de idempotencyKey sin fila visible (se borró entretanto)',
      );
    }
    return { id: existing.id, created: false };
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
    // retoma. Índice (state, runAt).
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
          ORDER BY c."runAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING j."id", j."name", j."tenantId", j."payload", j."attempts",
                j."maxAttempts"`;
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
        { name: string; nextRunAt: Date; now: Date }[]
      >`
        SELECT "name", "nextRunAt", ${NOW} AS "now"
          FROM "job_schedules"
         WHERE "name" = ANY(${[...byName.keys()]}::text[])
           AND "nextRunAt" <= ${NOW}
         FOR UPDATE SKIP LOCKED`;
      for (const row of due) {
        const s = byName.get(row.name);
        if (!s) continue;
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
      return due.length;
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
}
