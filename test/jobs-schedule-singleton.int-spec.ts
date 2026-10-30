import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { JobsAdmin } from '../src/modules/jobs/application/jobs-admin.service';
import { PrismaJobRepository } from '../src/modules/jobs/infrastructure/prisma-job.repository';
import type { JobsConfig } from '../src/modules/jobs/infrastructure/jobs-config';
import { deferred, waitFor } from './support/wait-for';

// DX-380 (OPS-046), capa de BD: una tarea programada `singleton` con DOS
// workers reales (dos PrismaService) y un barrido que tarda más que su
// periodo. El tick que llega con el anterior aún RUNNING no encola otro
// trabajo: deja `jobs.schedule_skipped`, cuenta en `stats` y no acumula
// PENDING. Sin sleeps: barreras (deferred) y polling con tope (waitFor).

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PREFIX = 'dx380-int';

function config(id: string): JobsConfig {
  return {
    role: 'worker',
    workerEnabled: false,
    workerId: `int:${id}:00000380`,
    pollIntervalMs: 100,
    concurrency: 4,
    leaseSeconds: 300,
    maxAttempts: 5,
    retryBaseMs: 60_000,
    shutdownGraceMs: 5_000,
    heartbeatMs: 50,
    retentionDays: 14,
    healthPort: null,
    version: null,
  };
}

function node(id: string) {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const repo = new PrismaJobRepository(prisma);
  const registry = new JobRegistry();
  return {
    prisma,
    registry,
    worker: new JobWorker(registry, repo, tenantContext, config(id)),
    admin: new JobsAdmin(repo, registry),
  };
}

async function purge(): Promise<void> {
  await owner.$executeRawUnsafe(
    `DELETE FROM "jobs" WHERE "name" LIKE '${PREFIX}.%'`,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM "job_workers" WHERE "id" LIKE 'int:%:00000380'`,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM "job_schedules" WHERE "name" LIKE '${PREFIX}.%'`,
  );
}

/** Un tick vencido hace `minutesAgo` minutos, en el segundo 0. */
function pastTick(minutesAgo: number): Date {
  const due = new Date(Date.now() - minutesAgo * 60_000);
  due.setUTCSeconds(0, 0);
  return due;
}

describe('DX-380 · tareas programadas singleton (int)', () => {
  const a = node('a');
  const b = node('b');
  let log: jest.SpyInstance;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await Promise.all([a.prisma.onModuleInit(), b.prisma.onModuleInit()]);
    await purge();
  });

  afterAll(async () => {
    await purge();
    await Promise.all([a.prisma.onModuleDestroy(), b.prisma.onModuleDestroy()]);
    await owner.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(async () => {
    await purge();
    log = jest.spyOn(Logger.prototype, 'log');
  });

  afterEach(() => log.mockRestore());

  /**
   * El mismo barrido lento en los dos "procesos": cada ejecución espera a que
   * el test abra su barrera. Devuelve cuántas empezaron y la barrera.
   */
  function slowSweep(job: string, schedule: string, singleton: boolean) {
    const gate = deferred();
    let started = 0;
    for (const n of [a, b]) {
      n.registry.register({
        name: job,
        maxAttempts: 1,
        handle: async () => {
          started += 1;
          await gate.promise;
        },
      });
      n.registry.schedule({
        name: schedule,
        cron: '* * * * *',
        job,
        singleton,
      });
    }
    return { gate, started: () => started };
  }

  const jobsOf = (job: string) =>
    owner.job.findMany({ where: { name: job }, orderBy: { createdAt: 'asc' } });

  const moveTick = (schedule: string, due: Date) =>
    owner.jobSchedule.update({
      where: { name: schedule },
      data: { nextRunAt: due },
    });

  it('dos ticks seguidos con el barrido aún RUNNING crean UN trabajo; el segundo queda en el log y en stats', async () => {
    const job = `${PREFIX}.slow-sweep`;
    const schedule = `${PREFIX}.slow-sweep.every-minute`;
    const sweep = slowSweep(job, schedule, true);
    await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);

    // Tick 1: el worker A lo dispara y lo empieza; tarda más que su periodo.
    await moveTick(schedule, pastTick(2));
    const first = a.worker.runOnce();
    await waitFor(() => sweep.started() === 1, 'el barrido arranca en A');

    // Tick 2 (y otra vuelta de cada worker): el anterior sigue RUNNING.
    const second = pastTick(1);
    await moveTick(schedule, second);
    await Promise.all([b.worker.runOnce(), a.worker.runOnce()]);
    await b.worker.runOnce();

    const during = await jobsOf(job);
    expect(during.map((j) => j.state)).toEqual(['RUNNING']);
    expect(sweep.started()).toBe(1);
    const row = await owner.jobSchedule.findUniqueOrThrow({
      where: { name: schedule },
    });
    expect(row).toMatchObject({ skippedCount: 1, lastSkippedAt: second });
    expect(row.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(log).toHaveBeenCalledWith({
      event: 'jobs.schedule_skipped',
      schedule,
    });
    const stats = await b.admin.stats();
    expect(stats.schedules.find((s) => s.name === schedule)).toMatchObject({
      singleton: true,
      skippedCount: 1,
      lastSkippedAt: second,
    });

    // Termina el barrido: el siguiente tick vuelve a encolar.
    sweep.gate.resolve();
    await first;
    await moveTick(schedule, pastTick(0));
    await Promise.all([a.worker.drain(), b.worker.drain()]);
    const after = await jobsOf(job);
    expect(after.map((j) => j.state)).toEqual(['COMPLETED', 'COMPLETED']);
    expect(
      await owner.job.count({
        where: { name: job, state: { in: ['PENDING', 'RUNNING'] } },
      }),
    ).toBe(0);
  });

  it('un PENDING sin reclamar también frena el tick siguiente: no se acumulan PENDING de la tarea', async () => {
    const job = `${PREFIX}.queued-sweep`;
    const schedule = `${PREFIX}.queued-sweep.every-minute`;
    // Los ticks se disparan con el repositorio, sin que ningún worker reclame
    // el trabajo: el primero queda PENDING (p. ej. todos los huecos ocupados).
    const sweep = slowSweep(job, schedule, true);
    await a.worker.runOnce();
    for (const minutesAgo of [3, 2, 1]) {
      await moveTick(schedule, pastTick(minutesAgo));
      // Disparar sin reclamar: la transacción de los ticks, sola.
      const fired = await new PrismaJobRepository(b.prisma).fireDueSchedules([
        {
          name: schedule,
          cron: '* * * * *',
          job,
          payload: {},
          maxAttempts: 1,
          singleton: true,
          nextRunAfter: (now) => new Date(now.getTime() + 60_000),
        },
      ]);
      expect(fired).toEqual(
        minutesAgo === 3
          ? { fired: 1, skipped: [] }
          : { fired: 0, skipped: [schedule] },
      );
    }
    expect((await jobsOf(job)).map((j) => j.state)).toEqual(['PENDING']);
    expect(
      await owner.jobSchedule.findUniqueOrThrow({ where: { name: schedule } }),
    ).toMatchObject({ skippedCount: 2 });
    sweep.gate.resolve();
    await a.worker.drain();
  });

  it('sin singleton (el comportamiento de antes) el segundo tick sí encola otro trabajo a la vez', async () => {
    const job = `${PREFIX}.overlap-sweep`;
    const schedule = `${PREFIX}.overlap-sweep.every-minute`;
    const sweep = slowSweep(job, schedule, false);
    await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);

    await moveTick(schedule, pastTick(2));
    const first = a.worker.runOnce();
    await waitFor(() => sweep.started() === 1, 'el barrido arranca en A');
    await moveTick(schedule, pastTick(1));
    const second = b.worker.runOnce();
    await waitFor(() => sweep.started() === 2, 'el segundo se solapa en B');

    expect((await jobsOf(job)).map((j) => j.state)).toEqual([
      'RUNNING',
      'RUNNING',
    ]);
    expect(
      await owner.jobSchedule.findUniqueOrThrow({ where: { name: schedule } }),
    ).toMatchObject({ skippedCount: 0, lastSkippedAt: null });
    sweep.gate.resolve();
    await Promise.all([first, second]);
  });
});
