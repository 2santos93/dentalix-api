import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import { JobQueue } from '../src/modules/jobs/application/job-queue.service';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { JobsAdmin } from '../src/modules/jobs/application/jobs-admin.service';
import { PrismaJobRepository } from '../src/modules/jobs/infrastructure/prisma-job.repository';
import type { JobsConfig } from '../src/modules/jobs/infrastructure/jobs-config';
import type { JobContext, JobPayload } from '../src/modules/jobs/domain/job';
import { deferred, waitFor } from './support/wait-for';

// DX-085, capa de BD: la cola `jobs` contra Postgres con DOS workers reales
// (dos PrismaService, dos pools de conexiones), como dos réplicas. Outbox con
// rollback y commit, idempotencia con concurrencia, cron con candado,
// reintentos con backoff hasta FAILED y arriendos vencidos. Sin sleeps: las
// esperas son barreras (deferred) o polling con tope (waitFor).

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['jobs-int-a', 'jobs-int-b'];
const PREFIX = 'test-int';

function config(overrides: Partial<JobsConfig> = {}): JobsConfig {
  return {
    role: 'worker',
    workerEnabled: false,
    workerId: 'int:0:00000000',
    pollIntervalMs: 100,
    concurrency: 8,
    leaseSeconds: 300,
    maxAttempts: 5,
    retryBaseMs: 60_000,
    shutdownGraceMs: 5_000,
    retentionDays: 14,
    ...overrides,
  };
}

interface Node {
  prisma: PrismaService;
  tenantContext: TenantContextService;
  registry: JobRegistry;
  queue: JobQueue;
  worker: JobWorker;
  repo: PrismaJobRepository;
}

/** Un "proceso": su pool, su contexto de tenant, su registro y su worker. */
function node(id: string, overrides: Partial<JobsConfig> = {}): Node {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const repo = new PrismaJobRepository(prisma);
  const registry = new JobRegistry();
  const cfg = config({ workerId: `int:${id}:00000000`, ...overrides });
  return {
    prisma,
    tenantContext,
    registry,
    repo,
    queue: new JobQueue(repo, registry, cfg),
    worker: new JobWorker(registry, repo, tenantContext, cfg),
  };
}

async function purge(): Promise<void> {
  await owner.$executeRawUnsafe(
    `DELETE FROM "jobs" WHERE "name" LIKE '${PREFIX}.%'`,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM "job_schedules" WHERE "name" LIKE '${PREFIX}.%'`,
  );
}

const jobsNamed = (name: string) =>
  owner.job.findMany({ where: { name }, orderBy: { createdAt: 'asc' } });

describe('DX-085 · cola de trabajos en Postgres (int)', () => {
  const a = node('a');
  const b = node('b');
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await Promise.all([a.prisma.onModuleInit(), b.prisma.onModuleInit()]);
    await purge();
    await owner.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
    const [ta, tb] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        owner.tenant.create({
          data: { name: `Clínica ${subdomain}`, subdomain },
        }),
      ),
    );
    tenantA = ta.id;
    tenantB = tb.id;
  });

  afterAll(async () => {
    await purge();
    await owner.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
    await Promise.all([a.prisma.onModuleDestroy(), b.prisma.onModuleDestroy()]);
    await owner.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(purge);

  /** Registra el mismo handler en los dos "procesos" (misma imagen). */
  function onBoth(
    name: string,
    handle: (payload: JobPayload, ctx: JobContext) => Promise<void>,
    extra: { maxAttempts?: number; retryBaseMs?: number } = {},
  ): void {
    for (const n of [a, b]) {
      n.registry.register({ name, handle, ...extra });
    }
  }

  describe('outbox: encolar dentro de la transacción de negocio', () => {
    it('si la transacción hace rollback, el trabajo no existe y no se ejecuta', async () => {
      const name = `${PREFIX}.rollback`;
      const runs: string[] = [];
      onBoth(name, (_p, ctx) => {
        runs.push(ctx.jobId);
        return Promise.resolve();
      });

      await expect(
        a.prisma.runWithTenant(tenantA, async (tx) => {
          await a.queue.enqueue(name, { appointmentId: tenantA }, { tx });
          throw new Error('el negocio falla después de encolar');
        }),
      ).rejects.toThrow('el negocio falla');

      expect(await jobsNamed(name)).toEqual([]);
      await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);
      expect(runs).toEqual([]);
    });

    it('si hace commit, se ejecuta UNA vez, bajo el tenant de la transacción', async () => {
      const name = `${PREFIX}.commit`;
      const seen: {
        tenant: string | null;
        ctxTenant?: string;
        setting: string;
      }[] = [];
      const register = (n: Node) =>
        n.registry.register({
          name,
          handle: async (_payload, ctx) => {
            // El handler lee con runWithTenant SIN tenant explícito: lo toma
            // del contexto que fijó el worker.
            const [{ setting }] = await n.prisma.runWithTenant(
              (tx) =>
                tx.$queryRaw<{ setting: string }[]>`
                SELECT current_setting('app.current_tenant', true) AS setting`,
            );
            seen.push({
              tenant: ctx.tenantId,
              ctxTenant: n.tenantContext.getTenantId(),
              setting,
            });
          },
        });
      register(a);
      register(b);

      const result = await a.prisma.runWithTenant(tenantA, (tx) =>
        a.queue.enqueue(name, { appointmentId: tenantB }, { tx }),
      );
      expect(result.created).toBe(true);

      await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);
      await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);

      expect(seen).toEqual([
        { tenant: tenantA, ctxTenant: tenantA, setting: tenantA },
      ]);
      const [job] = await jobsNamed(name);
      expect(job).toMatchObject({
        id: result.id,
        tenantId: tenantA,
        state: 'COMPLETED',
        attempts: 1,
        lockedBy: null,
      });
      expect(job.finishedAt).toBeInstanceOf(Date);
    });

    it('fuera de una transacción de tenant, el trabajo es de plataforma salvo tenantId explícito', async () => {
      const name = `${PREFIX}.platform`;
      onBoth(name, () => Promise.resolve());

      const platform = await a.queue.enqueue(name, {});
      const scoped = await a.queue.enqueue(name, {}, { tenantId: tenantB });

      const rows = await jobsNamed(name);
      expect(rows.find((r) => r.id === platform.id)?.tenantId).toBeNull();
      expect(rows.find((r) => r.id === scoped.id)?.tenantId).toBe(tenantB);
    });

    it('rechaza un trabajo sin handler registrado y un payload que no es un objeto', async () => {
      await expect(a.queue.enqueue(`${PREFIX}.nadie`, {})).rejects.toThrow(
        /no registrado/,
      );
      const name = `${PREFIX}.payload`;
      onBoth(name, () => Promise.resolve());
      await expect(
        a.queue.enqueue(name, ['x'] as unknown as JobPayload),
      ).rejects.toThrow(/payload/);
    });
  });

  describe('idempotencia y concurrencia con dos workers', () => {
    it('dos transacciones concurrentes con la misma idempotencyKey crean UN trabajo, que se ejecuta una vez', async () => {
      const name = `${PREFIX}.idempotent`;
      let runs = 0;
      onBoth(name, () => {
        runs += 1;
        return Promise.resolve();
      });
      const key = `${PREFIX}:recordatorio:cita-1`;

      // A inserta y se queda con la transacción abierta; B choca con el
      // índice único y ESPERA (no crea otra fila) hasta que A hace commit.
      const inserted = deferred();
      const commitA = deferred();
      const txA = a.prisma.runWithTenant(tenantA, async (tx) => {
        const r = await a.queue.enqueue(name, {}, { tx, idempotencyKey: key });
        inserted.resolve();
        await commitA.promise;
        return r;
      });
      await inserted.promise;
      const txB = b.prisma.runWithTenant(tenantA, (tx) =>
        b.queue.enqueue(name, {}, { tx, idempotencyKey: key }),
      );
      await waitFor(async () => {
        const [{ waiting }] = await owner.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        return waiting > 0n;
      }, 'B espera el candado del índice único');
      commitA.resolve();
      const [ra, rb] = await Promise.all([txA, txB]);

      expect(ra.created).toBe(true);
      expect(rb).toEqual({ id: ra.id, created: false });
      expect(await jobsNamed(name)).toHaveLength(1);

      await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);
      await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);
      expect(runs).toBe(1);

      // Ya terminado, la misma clave sigue sin crear otro.
      expect(await b.queue.enqueue(name, {}, { idempotencyKey: key })).toEqual({
        id: ra.id,
        created: false,
      });
    });

    it('si la primera transacción hace rollback, la segunda con la misma clave sí lo crea', async () => {
      const name = `${PREFIX}.idempotent-rollback`;
      onBoth(name, () => Promise.resolve());
      const key = `${PREFIX}:rollback`;
      await expect(
        a.prisma.runWithTenant(tenantA, async (tx) => {
          await a.queue.enqueue(name, {}, { tx, idempotencyKey: key });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      const r = await b.queue.enqueue(name, {}, { idempotencyKey: key });
      expect(r.created).toBe(true);
    });

    it('con 40 trabajos y dos workers en paralelo, cada uno se ejecuta exactamente una vez', async () => {
      const name = `${PREFIX}.fanout`;
      const runs = new Map<string, number>();
      const ranOn = new Set<string>();
      for (const [id, n] of [
        ['a', a],
        ['b', b],
      ] as const) {
        n.registry.register({
          name,
          handle: async (_p, ctx) => {
            runs.set(ctx.jobId, (runs.get(ctx.jobId) ?? 0) + 1);
            ranOn.add(id);
            // Cede el turno para que el otro worker reclame mientras tanto.
            await new Promise((resolve) => setImmediate(resolve));
          },
        });
      }
      for (let i = 0; i < 40; i++) {
        await a.queue.enqueue(name, { i });
      }

      await Promise.all([a.worker.drain(), b.worker.drain()]);

      expect(runs.size).toBe(40);
      expect([...runs.values()].every((count) => count === 1)).toBe(true);
      const rows = await jobsNamed(name);
      expect(rows.every((r) => r.state === 'COMPLETED')).toBe(true);
    });
  });

  describe('tareas programadas (cron) con candado', () => {
    it('una tarea de cada minuto corre UNA vez por tick con dos workers', async () => {
      const job = `${PREFIX}.cron-job`;
      const schedule = `${PREFIX}.cron-job.every-minute`;
      let runs = 0;
      for (const n of [a, b]) {
        n.registry.register({
          name: job,
          handle: () => {
            runs += 1;
            return Promise.resolve();
          },
        });
        n.registry.schedule({ name: schedule, cron: '* * * * *', job });
      }

      // Primer tick: ninguno ha llegado (el próximo minuto está por venir).
      await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);
      const synced = await owner.jobSchedule.findUniqueOrThrow({
        where: { name: schedule },
      });
      expect(synced.cron).toBe('* * * * *');
      expect(synced.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(synced.nextRunAt.getUTCSeconds()).toBe(0);
      expect(runs).toBe(0);

      // Llega el tick (se adelanta el reloj de la tarea, no se duerme).
      for (const tick of [1, 2]) {
        const due = new Date(Date.now() - tick * 60_000);
        due.setUTCSeconds(0, 0);
        await owner.jobSchedule.update({
          where: { name: schedule },
          data: { nextRunAt: due },
        });
        await Promise.all([
          a.worker.runOnce(),
          b.worker.runOnce(),
          a.worker.runOnce(),
          b.worker.runOnce(),
        ]);
        await Promise.all([a.worker.drain(), b.worker.drain()]);
        expect(runs).toBe(tick);

        const after = await owner.jobSchedule.findUniqueOrThrow({
          where: { name: schedule },
        });
        expect(after.lastRunAt).toEqual(due);
        expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 1000);
        const jobs = await jobsNamed(job);
        expect(jobs).toHaveLength(tick);
        expect(jobs[tick - 1].idempotencyKey).toBe(
          `schedule:${schedule}:${due.toISOString()}`,
        );
      }
    });

    it('cambiar el cron de una tarea reprograma su próximo tick', async () => {
      const job = `${PREFIX}.cron-change`;
      const schedule = `${PREFIX}.cron-change.daily`;
      a.registry.register({ name: job, handle: () => Promise.resolve() });
      a.registry.schedule({ name: schedule, cron: '* * * * *', job });
      await a.worker.runOnce();

      const c = node('c');
      c.registry.register({ name: job, handle: () => Promise.resolve() });
      c.registry.schedule({ name: schedule, cron: '7 3 * * *', job });
      await c.prisma.onModuleInit();
      try {
        await c.worker.runOnce();
      } finally {
        await c.prisma.onModuleDestroy();
      }
      const row = await owner.jobSchedule.findUniqueOrThrow({
        where: { name: schedule },
      });
      expect(row.cron).toBe('7 3 * * *');
      expect(row.nextRunAt.getUTCHours()).toBe(3);
      expect(row.nextRunAt.getUTCMinutes()).toBe(7);
    });
  });

  describe('reintentos con backoff y cola de fallidos', () => {
    it('un fallo se reintenta con backoff exponencial hasta N veces y queda FAILED, sin el mensaje del error', async () => {
      const name = `${PREFIX}.always-fails`;
      let runs = 0;
      onBoth(
        name,
        () => {
          runs += 1;
          return Promise.reject(
            Object.assign(new Error('ana.perez@correo.co no responde'), {
              code: 'ETIMEDOUT',
            }),
          );
        },
        { maxAttempts: 3, retryBaseMs: 60_000 },
      );
      const { id } = await a.queue.enqueue(name, { patientId: tenantA });

      for (const [attempt, delay] of [
        [1, 60_000],
        [2, 120_000],
      ] as const) {
        const before = Date.now();
        await a.worker.runOnce();
        const row = await owner.job.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject({
          state: 'PENDING',
          attempts: attempt,
          maxAttempts: 3,
          lastError: 'Error ETIMEDOUT',
          lockedBy: null,
          finishedAt: null,
        });
        // La próxima hora es ahora + base·2^(intento-1) (margen del reloj de la BD).
        expect(row.runAt.getTime()).toBeGreaterThanOrEqual(
          before + delay - 2000,
        );
        expect(row.runAt.getTime()).toBeLessThanOrEqual(
          Date.now() + delay + 2000,
        );

        // Antes de su hora nadie lo coge.
        await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);
        expect(runs).toBe(attempt);
        // Llega su hora.
        await owner.job.update({
          where: { id },
          data: { runAt: new Date(Date.now() - 1000) },
        });
      }

      await b.worker.runOnce();
      const failed = await owner.job.findUniqueOrThrow({ where: { id } });
      expect(failed).toMatchObject({
        state: 'FAILED',
        attempts: 3,
        lastError: 'Error ETIMEDOUT',
      });
      expect(failed.finishedAt).toBeInstanceOf(Date);
      expect(runs).toBe(3);

      // Fallido: ya no se reintenta solo.
      await owner.job.update({
        where: { id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);
      expect(runs).toBe(3);

      // Visible en la cola de fallidos.
      const admin = new JobsAdmin(a.repo);
      const list = await admin.listFailed(100);
      expect(list.find((j) => j.id === id)).toMatchObject({
        name,
        attempts: 3,
        maxAttempts: 3,
        lastError: 'Error ETIMEDOUT',
        payload: { patientId: tenantA },
      });
    });

    it('un arriendo vencido (worker caído) se retoma; en el último intento queda FAILED sin ejecutarse', async () => {
      const name = `${PREFIX}.lease`;
      let runs = 0;
      onBoth(
        name,
        () => {
          runs += 1;
          return Promise.resolve();
        },
        { maxAttempts: 2 },
      );
      const retaken = await a.queue.enqueue(name, { n: 1 });
      const exhausted = await a.queue.enqueue(name, { n: 2 });
      // Dos trabajos que un worker reclamó y abandonó (arriendo vencido).
      await owner.job.update({
        where: { id: retaken.id },
        data: {
          state: 'RUNNING',
          attempts: 1,
          lockedBy: 'muerto:1:00000000',
          runAt: new Date(Date.now() - 1000),
        },
      });
      await owner.job.update({
        where: { id: exhausted.id },
        data: {
          state: 'RUNNING',
          attempts: 2,
          lockedBy: 'muerto:1:00000000',
          runAt: new Date(Date.now() - 1000),
        },
      });

      await b.worker.runOnce();

      expect(runs).toBe(1);
      expect(
        await owner.job.findUniqueOrThrow({ where: { id: retaken.id } }),
      ).toMatchObject({ state: 'COMPLETED', attempts: 2 });
      expect(
        await owner.job.findUniqueOrThrow({ where: { id: exhausted.id } }),
      ).toMatchObject({
        state: 'FAILED',
        attempts: 3,
        lastError: 'LeaseExpired',
      });
    });

    it('el cierre tardío de un worker cuyo arriendo venció no pisa el del worker que lo retomó', async () => {
      const name = `${PREFIX}.fencing`;
      onBoth(name, () => Promise.resolve());
      const { id } = await a.queue.enqueue(name, {});
      const [claimed] = await a.repo.claim([name], 1, 300, 'int:a:00000000');
      expect(claimed.attempts).toBe(1);
      // Vence el arriendo y B lo retoma y lo termina.
      await owner.job.update({
        where: { id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await b.worker.runOnce();
      // A cierra su intento (el 1) tarde: no cambia nada.
      expect(await a.repo.reschedule(id, 1, 60_000, 'Error')).toBe(false);
      expect(
        await owner.job.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ state: 'COMPLETED', attempts: 2, lastError: null });
    });
  });

  it('la purga borra los terminados más antiguos que la retención y nada más', async () => {
    const name = `${PREFIX}.purge`;
    onBoth(name, () => Promise.resolve());
    const old = new Date(Date.now() - 20 * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);
    const ids = await Promise.all(
      [
        { state: 'COMPLETED' as const, finishedAt: old },
        { state: 'FAILED' as const, finishedAt: old },
        { state: 'COMPLETED' as const, finishedAt: recent },
        { state: 'PENDING' as const, finishedAt: null },
      ].map(async (data) => {
        const { id } = await a.queue.enqueue(name, {});
        await owner.job.update({ where: { id }, data });
        return id;
      }),
    );

    const purged = await a.repo.purgeFinished(
      new Date(Date.now() - 14 * 86_400_000),
    );

    expect(purged).toBeGreaterThanOrEqual(2);
    const left = (await jobsNamed(name)).map((j) => j.id).sort();
    expect(left).toEqual([ids[2], ids[3]].sort());
  });
});
