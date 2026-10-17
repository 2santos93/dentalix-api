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
    heartbeatMs: 50,
    retentionDays: 14,
    healthPort: null,
    version: null,
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
    queue: new JobQueue(repo, registry, cfg, tenantContext),
    worker: new JobWorker(registry, repo, tenantContext, cfg),
  };
}

async function purge(): Promise<void> {
  await owner.$executeRawUnsafe(
    `DELETE FROM "jobs" WHERE "name" LIKE '${PREFIX}.%'`,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM "job_workers" WHERE "id" LIKE 'int:%'`,
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
      // pg_locks (no pg_stat_activity, que a un owner sin superusuario le
      // oculta las sesiones de otros roles): hay un candado sin conceder.
      await waitFor(async () => {
        const [{ waiting }] = await owner.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_locks
          WHERE NOT granted
            AND (database IS NULL OR database = (
              SELECT oid FROM pg_database WHERE datname = current_database()))`;
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

      // Ya terminado, la misma clave en la misma clínica sigue sin crear otro.
      expect(
        await b.queue.enqueue(
          name,
          {},
          { idempotencyKey: key, tenantId: tenantA },
        ),
      ).toEqual({ id: ra.id, created: false });
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

  describe('tenant del trabajo (revisión H2, H3) e idempotencia por clínica (H4)', () => {
    it('dentro de una petición de clínica, enqueue sin tx es un error (el outbox exige tx)', async () => {
      const name = `${PREFIX}.ctx-sin-tx`;
      onBoth(name, () => Promise.resolve());
      await expect(
        a.tenantContext.run(tenantA, () => a.queue.enqueue(name, {})),
      ).rejects.toThrow(/exige `tx`/);
      expect(await jobsNamed(name)).toEqual([]);
    });

    it('con contexto de clínica, el trabajo es de esa clínica (con tx, o fuera de transacción si se pide a propósito)', async () => {
      const name = `${PREFIX}.ctx-tenant`;
      onBoth(name, () => Promise.resolve());
      const inTx = await a.tenantContext.run(tenantA, () =>
        a.prisma.runWithTenant((tx) => a.queue.enqueue(name, {}, { tx })),
      );
      const outside = await a.tenantContext.run(tenantA, () =>
        a.queue.enqueue(name, {}, { outsideTransaction: true }),
      );
      const rows = await jobsNamed(name);
      expect(rows.map((r) => [r.id, r.tenantId]).sort()).toEqual(
        [
          [inTx.id, tenantA],
          [outside.id, tenantA],
        ].sort(),
      );
    });

    it('un tenantId explícito que no casa con el contexto o con la transacción es un error', async () => {
      const name = `${PREFIX}.ctx-mismatch`;
      onBoth(name, () => Promise.resolve());
      await expect(
        a.tenantContext.run(tenantA, () =>
          a.queue.enqueue(
            name,
            {},
            { tenantId: tenantB, outsideTransaction: true },
          ),
        ),
      ).rejects.toThrow(/no coincide/);
      await expect(
        a.prisma.runWithTenant(tenantA, (tx) =>
          a.queue.enqueue(name, {}, { tx, tenantId: tenantB }),
        ),
      ).rejects.toThrow(/no coincide/);
      await expect(
        a.prisma.runWithTenant(tenantA, (tx) =>
          a.queue.enqueue(name, {}, { tx, tenantId: null }),
        ),
      ).rejects.toThrow(/no coincide/);
      expect(await jobsNamed(name)).toEqual([]);
    });

    it('la misma idempotencyKey en dos clínicas (y en plataforma) son tres trabajos distintos', async () => {
      const name = `${PREFIX}.key-scope`;
      onBoth(name, () => Promise.resolve());
      const key = `${PREFIX}:informe-diario:2026-10-16`;
      const inA = await a.prisma.runWithTenant(tenantA, (tx) =>
        a.queue.enqueue(name, {}, { tx, idempotencyKey: key }),
      );
      const inB = await a.prisma.runWithTenant(tenantB, (tx) =>
        a.queue.enqueue(name, {}, { tx, idempotencyKey: key }),
      );
      const platform = await a.queue.enqueue(name, {}, { idempotencyKey: key });
      const again = await a.queue.enqueue(name, {}, { idempotencyKey: key });
      const againB = await a.queue.enqueue(
        name,
        {},
        { idempotencyKey: key, tenantId: tenantB },
      );

      expect([inA.created, inB.created, platform.created]).toEqual([
        true,
        true,
        true,
      ]);
      expect(new Set([inA.id, inB.id, platform.id]).size).toBe(3);
      expect(again).toEqual({ id: platform.id, created: false });
      expect(againB).toEqual({ id: inB.id, created: false });
    });
  });

  describe('latido del arriendo (revisión H1)', () => {
    it('mientras el handler trabaja, el latido renueva el arriendo y otro worker no lo retoma', async () => {
      const name = `${PREFIX}.heartbeat`;
      const started = deferred();
      const release = deferred();
      let runs = 0;
      onBoth(name, async () => {
        runs += 1;
        started.resolve();
        await release.promise;
      });
      const { id } = await a.queue.enqueue(name, {});
      const running = a.worker.runOnce();
      await started.promise;

      // El arriendo «vence» (como si el handler llevara más de lo pactado).
      const expired = new Date(Date.now() - 1000);
      await owner.job.update({ where: { id }, data: { runAt: expired } });
      await waitFor(async () => {
        const row = await owner.job.findUniqueOrThrow({ where: { id } });
        return row.runAt.getTime() > Date.now();
      }, 'el latido renueva el arriendo');

      await b.worker.runOnce();
      expect(runs).toBe(1);

      release.resolve();
      await running;
      expect(
        await owner.job.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ state: 'COMPLETED', attempts: 1, lastError: null });
    });

    it('si el intento ya lo reclamó otro worker, el latido falla, el handler recibe abort y su cierre no pisa nada', async () => {
      const name = `${PREFIX}.heartbeat-lost`;
      const started = deferred();
      let aborted = false;
      onBoth(
        name,
        (_payload, ctx) => {
          started.resolve();
          return new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
          });
        },
        { maxAttempts: 2 },
      );
      const { id } = await a.queue.enqueue(name, {});
      const running = a.worker.runOnce();
      await started.promise;

      // Otro worker lo retomó (intento 2) mientras A seguía.
      await owner.job.update({
        where: { id },
        data: { attempts: 2, lockedBy: 'otro:1:00000000' },
      });
      await running;

      expect(aborted).toBe(true);
      expect(
        await owner.job.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        state: 'RUNNING',
        attempts: 2,
        lockedBy: 'otro:1:00000000',
      });
      expect(await a.repo.heartbeat(id, 1, 300)).toBe(false);
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

    it('una réplica con otro cron (despliegue escalonado) no dispara ni reprograma la tarea (revisión H5)', async () => {
      const job = `${PREFIX}.cron-stale`;
      const schedule = `${PREFIX}.cron-stale.every-minute`;
      let runs = 0;
      a.registry.register({
        name: job,
        handle: () => {
          runs += 1;
          return Promise.resolve();
        },
      });
      a.registry.schedule({ name: schedule, cron: '* * * * *', job });
      await a.worker.runOnce();
      // La réplica nueva ya sincronizó otro cron.
      const due = new Date(Date.now() - 60_000);
      due.setUTCSeconds(0, 0);
      await owner.jobSchedule.update({
        where: { name: schedule },
        data: { cron: '7 3 * * *', nextRunAt: due },
      });

      await a.worker.drain();

      expect(runs).toBe(0);
      expect(
        await owner.jobSchedule.findUniqueOrThrow({
          where: { name: schedule },
        }),
      ).toMatchObject({ cron: '7 3 * * *', nextRunAt: due });
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
      const admin = new JobsAdmin(a.repo, a.registry);
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
      // DX-220: lo cierra failExhausted SIN sumar intento (antes, el reclamo
      // lo subía a maxAttempts + 1).
      expect(
        await owner.job.findUniqueOrThrow({ where: { id: exhausted.id } }),
      ).toMatchObject({
        state: 'FAILED',
        attempts: 2,
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

  describe('DX-220 · sin fila envenenada, latido, stats y reintento', () => {
    /** Un trabajo que un worker reclamó y abandonó (arriendo vencido). */
    async function abandoned(
      name: string,
      data: { attempts: number; maxAttempts: number; runAt?: Date },
    ): Promise<string> {
      const { id } = await a.queue.enqueue(name, {});
      await owner.job.update({
        where: { id },
        data: {
          state: 'RUNNING',
          lockedBy: 'muerto:1:00000000',
          runAt: data.runAt ?? new Date(Date.now() - 60_000),
          attempts: data.attempts,
          maxAttempts: data.maxAttempts,
        },
      });
      return id;
    }

    it('OPS-030: una RUNNING vencida con attempts = maxAttempts + 1, la PRIMERA por runAt, no para la cola: en la misma vuelta queda FAILED LeaseExpired y el resto se ejecuta', async () => {
      const name = `${PREFIX}.poison`;
      const runs: string[] = [];
      onBoth(name, (_p, ctx) => {
        runs.push(ctx.jobId);
        return Promise.resolve();
      });
      // La envenenada, la más antigua: el reclamo la vería la primera.
      const poison = await abandoned(name, {
        attempts: 3,
        maxAttempts: 2,
        runAt: new Date(Date.now() - 3_600_000),
      });
      const healthy = await Promise.all(
        [1, 2, 3].map(async (n) => (await a.queue.enqueue(name, { n })).id),
      );

      // Antes de DX-220 el reclamo (una sola sentencia para el lote) violaba
      // jobs_attempts_check aquí y fallaba en cada vuelta.
      await expect(
        a.repo.claim([name], 10, 300, 'int:a:00000000'),
      ).resolves.toHaveLength(3);
      await owner.job.updateMany({
        where: { id: { in: healthy } },
        data: { state: 'PENDING', attempts: 0, runAt: new Date(0) },
      });

      expect(await a.worker.runOnce()).toBe(3);

      expect(runs.sort()).toEqual([...healthy].sort());
      expect(
        await owner.job.findUniqueOrThrow({ where: { id: poison } }),
      ).toMatchObject({
        state: 'FAILED',
        attempts: 3,
        lastError: 'LeaseExpired',
        lockedBy: null,
      });
    });

    it('claim() nunca escribe attempts > maxAttempts + 1: ignora las filas con attempts > maxAttempts aunque vayan primero por runAt', async () => {
      const name = `${PREFIX}.claim-bound`;
      onBoth(name, () => Promise.resolve());
      const poison = await abandoned(name, {
        attempts: 3,
        maxAttempts: 2,
        runAt: new Date(Date.now() - 3_600_000),
      });
      const last = await abandoned(name, { attempts: 2, maxAttempts: 2 });
      const { id: fresh } = await a.queue.enqueue(name, {});

      const claimed = await a.repo.claim([name], 10, 300, 'int:a:00000000');

      // La envenenada no se toca; la del último intento sí se puede reclamar
      // (llega a maxAttempts + 1, el máximo del CHECK) y el worker la cierra.
      expect(claimed.map((c) => c.id).sort()).toEqual([last, fresh].sort());
      expect(claimed.every((c) => c.attempts <= c.maxAttempts + 1)).toBe(true);
      expect(
        await owner.job.findUniqueOrThrow({ where: { id: poison } }),
      ).toMatchObject({ state: 'RUNNING', attempts: 3 });
    });

    it('failExhausted cierra SIN sumar intento solo las RUNNING vencidas con attempts >= maxAttempts', async () => {
      const name = `${PREFIX}.exhausted`;
      onBoth(name, () => Promise.resolve());
      const last = await abandoned(name, { attempts: 2, maxAttempts: 2 });
      const poison = await abandoned(name, { attempts: 3, maxAttempts: 2 });
      const retakable = await abandoned(name, { attempts: 1, maxAttempts: 2 });
      const alive = await abandoned(name, {
        attempts: 2,
        maxAttempts: 2,
        runAt: new Date(Date.now() + 300_000),
      });

      const closed = await a.repo.failExhausted(100);

      expect(
        closed
          .filter((c) => c.name === name)
          .map((c) => c.id)
          .sort(),
      ).toEqual([last, poison].sort());
      const rows = new Map(
        (await jobsNamed(name)).map((r) => [r.id, r] as const),
      );
      expect(rows.get(last)).toMatchObject({
        state: 'FAILED',
        attempts: 2,
        lastError: 'LeaseExpired',
      });
      expect(rows.get(last)?.finishedAt).toBeInstanceOf(Date);
      expect(rows.get(poison)).toMatchObject({ state: 'FAILED', attempts: 3 });
      expect(rows.get(retakable)).toMatchObject({ state: 'RUNNING' });
      // Arriendo vigente: su worker sigue con él.
      expect(rows.get(alive)).toMatchObject({ state: 'RUNNING', attempts: 2 });
    });

    it('el bucle del worker late en job_workers (id, papel, versión) y la purga borra los que llevan 7 días sin latir', async () => {
      const c = node('beat', {
        role: 'all',
        version: 'int-1.2.3',
        pollIntervalMs: 50,
      });
      await c.prisma.onModuleInit();
      try {
        c.worker.start();
        await waitFor(
          async () =>
            (await owner.jobWorker.count({
              where: { id: 'int:beat:00000000' },
            })) === 1,
          'el worker late',
        );
        const first = await owner.jobWorker.findUniqueOrThrow({
          where: { id: 'int:beat:00000000' },
        });
        expect(first).toMatchObject({ role: 'all', version: 'int-1.2.3' });
        await waitFor(async () => {
          const row = await owner.jobWorker.findUniqueOrThrow({
            where: { id: 'int:beat:00000000' },
          });
          return row.lastBeatAt > first.lastBeatAt;
        }, 'el latido avanza en cada vuelta');
        expect(c.worker.liveness.report().alive).toBe(true);
      } finally {
        await c.worker.stop();
        await c.prisma.onModuleDestroy();
      }

      await owner.jobWorker.create({
        data: {
          id: 'int:viejo:00000000',
          role: 'worker',
          lastBeatAt: new Date(Date.now() - 8 * 86_400_000),
        },
      });
      const purged = await a.repo.purgeStaleWorkers(
        new Date(Date.now() - 7 * 86_400_000),
      );
      expect(purged).toBeGreaterThanOrEqual(1);
      const left = await owner.jobWorker.findMany({
        where: { id: { startsWith: 'int:' } },
        select: { id: true },
      });
      expect(left.map((w) => w.id)).toEqual(['int:beat:00000000']);
    });

    it('statementTimeoutMs lee el statement_timeout efectivo de la conexión', async () => {
      await expect(a.repo.statementTimeoutMs()).resolves.toBe(0);
      const [{ ms }] = await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '45s'`;
        return tx.$queryRaw<{ ms: number }[]>`
          SELECT (EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval)
                  * 1000)::float8 AS "ms"`;
      });
      expect(ms).toBe(45_000);
    });

    it('snapshot: PENDING vencidos y su retraso, RUNNING vencidos, FAILED de 24 h y workers vivos', async () => {
      const name = `${PREFIX}.stats`;
      onBoth(name, () => Promise.resolve());
      const before = await a.repo.snapshot();
      const { id: due } = await a.queue.enqueue(name, {});
      await owner.job.update({
        where: { id: due },
        data: { runAt: new Date(Date.now() - 10 * 60_000) },
      });
      await a.queue.enqueue(
        name,
        {},
        { runAt: new Date(Date.now() + 3_600_000) },
      );
      await abandoned(name, { attempts: 1, maxAttempts: 3 });
      const { id: failed } = await a.queue.enqueue(name, {});
      await owner.job.update({
        where: { id: failed },
        data: { state: 'FAILED', finishedAt: new Date(), attempts: 3 },
      });
      await owner.jobWorker.createMany({
        data: [
          { id: 'int:vivo:00000000', role: 'worker' },
          {
            id: 'int:caido:00000000',
            role: 'worker',
            lastBeatAt: new Date(Date.now() - 120_000),
          },
        ],
      });

      const snap = await a.repo.snapshot();

      expect(snap.pendingDue - before.pendingDue).toBe(1);
      expect(snap.pendingScheduled - before.pendingScheduled).toBe(1);
      expect(snap.runningExpired - before.runningExpired).toBe(1);
      expect(snap.failedLast24h - before.failedLast24h).toBe(1);
      expect(
        snap.now.getTime() - (snap.oldestDueRunAt as Date).getTime(),
      ).toBeGreaterThanOrEqual(10 * 60_000 - 2000);
      const workers = new Map(snap.workers.map((w) => [w.id, w.alive]));
      expect(workers.get('int:vivo:00000000')).toBe(true);
      expect(workers.get('int:caido:00000000')).toBe(false);
      // Sin payloads en ninguna parte.
      expect(JSON.stringify(snap)).not.toContain('payload');
    });

    describe('reintento de un FAILED', () => {
      let actorId: string;

      beforeAll(async () => {
        const user = await owner.user.create({
          data: {
            email: `superadmin-${Date.now()}@jobs-int.test`,
            passwordHash: 'x',
            fullName: 'Super Admin',
            isPlatformAdmin: true,
          },
        });
        actorId = user.id;
      });

      afterAll(async () => {
        // Base de test: el owner local es superusuario y el trigger
        // append-only le deja borrar.
        await owner.$executeRaw`
          DELETE FROM "platform_audit_events" WHERE "actorUserId" = ${actorId}::uuid`;
        await owner.user.delete({ where: { id: actorId } });
      });

      const actor = () => ({
        userId: actorId,
        requestId: 'req-int-1',
        ip: '10.0.0.1',
        userAgent: 'jest',
      });

      it('lo devuelve a PENDING con attempts 0 UNA vez (también con dos a la vez), se ejecuta y queda auditado sin el payload', async () => {
        const name = `${PREFIX}.retry`;
        let runs = 0;
        let fail = true;
        onBoth(
          name,
          () => {
            runs += 1;
            return fail
              ? Promise.reject(new TypeError('x'))
              : Promise.resolve();
          },
          { maxAttempts: 1 },
        );
        const { id } = await a.queue.enqueue(
          name,
          { appointmentId: tenantA },
          { tenantId: tenantA, idempotencyKey: `${PREFIX}:retry:1` },
        );
        await a.worker.runOnce();
        expect(
          await owner.job.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({ state: 'FAILED', attempts: 1 });

        const [first, second] = await Promise.all([
          a.repo.retryFailed(id, actor()),
          b.repo.retryFailed(id, actor()),
        ]);
        const results = [first, second].map((r) => r.status).sort();
        expect(results).toEqual(['not_failed', 'retried']);
        const retried = [first, second].find((r) => r.status === 'retried');
        expect(retried).toEqual({
          status: 'retried',
          job: {
            id,
            name,
            tenantId: tenantA,
            previousAttempts: 1,
            lastError: 'TypeError',
          },
        });
        const row = await owner.job.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject({
          state: 'PENDING',
          attempts: 0,
          finishedAt: null,
          lockedBy: null,
          idempotencyKey: `${PREFIX}:retry:1`,
        });
        expect(row.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 2000);

        fail = false;
        await a.worker.runOnce();
        expect(runs).toBe(2);
        expect(
          await owner.job.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({ state: 'COMPLETED', attempts: 1 });
        // Ya no está FAILED: otro reintento no hace nada.
        await expect(a.repo.retryFailed(id, actor())).resolves.toEqual({
          status: 'not_failed',
          state: 'COMPLETED',
        });

        const audit = await owner.platformAuditEvent.findMany({
          where: { resourceId: id },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actorUserId: actorId,
          action: 'JOB_RETRIED',
          resourceType: 'JOB',
          requestId: 'req-int-1',
          ip: '10.0.0.1',
          userAgent: 'jest',
          metadata: {
            jobName: name,
            tenantId: tenantA,
            previousAttempts: 1,
            lastError: 'TypeError',
          },
        });
        expect(JSON.stringify(audit)).not.toContain('appointmentId');
      });

      it('un id que no existe da not_found y no audita nada', async () => {
        const missing = '00000000-0000-4000-8000-00000000dead';
        await expect(a.repo.retryFailed(missing, actor())).resolves.toEqual({
          status: 'not_found',
        });
        expect(
          await owner.platformAuditEvent.count({
            where: { resourceId: missing },
          }),
        ).toBe(0);
      });

      it('la purga de terminados no borra un FAILED que un reintento acaba de devolver a PENDING (carrera con el candado de retry)', async () => {
        const name = `${PREFIX}.retry-purge`;
        onBoth(name, () => Promise.resolve());
        const { id } = await a.queue.enqueue(name, {});
        await owner.job.update({
          where: { id },
          data: { state: 'FAILED', finishedAt: new Date(), attempts: 5 },
        });
        const purges: Promise<number>[] = [];
        // Lo mismo que hace retryFailed: FOR UPDATE y a PENDING, sin confirmar
        // aún, mientras la purga diaria arranca con su foto de antes.
        await owner.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1 FROM "jobs" WHERE "id" = ${id}::uuid FOR UPDATE`;
            await tx.$executeRaw`
              UPDATE "jobs" SET "state" = 'PENDING', "attempts" = 0, "finishedAt" = NULL
               WHERE "id" = ${id}::uuid`;
            purges.push(a.repo.purgeFinished(new Date(Date.now() + 60_000)));
            await waitFor(async () => {
              const [{ n }] = await b.prisma.$queryRaw<{ n: number }[]>`
                SELECT count(*)::int AS "n" FROM pg_stat_activity
                 WHERE "wait_event_type" = 'Lock' AND "query" LIKE '%DELETE FROM "jobs"%'`;
              return n > 0;
            }, 'la purga espera al candado del reintento');
          },
          { timeout: 10_000 },
        );
        await Promise.all(purges);
        expect(await owner.job.findUnique({ where: { id } })).toMatchObject({
          state: 'PENDING',
          attempts: 0,
        });
      });

      it('platform_audit_events es append-only para el rol de la app', async () => {
        await expect(
          a.prisma.$executeRaw`UPDATE "platform_audit_events" SET "ip" = NULL`,
        ).rejects.toThrow();
        await expect(
          a.prisma.$executeRaw`DELETE FROM "platform_audit_events"`,
        ).rejects.toThrow();
      });
    });
  });
});
