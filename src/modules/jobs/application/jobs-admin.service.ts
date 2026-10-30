import { Inject, Injectable, Logger } from '@nestjs/common';
import { parseCron } from '../domain/cron';
import { JOB_REPOSITORY } from '../domain/job-repository.port';
import type { JobRepository } from '../domain/job-repository.port';
import type {
  FailedJob,
  PlatformActor,
  RetryResult,
  WorkerRow,
} from '../domain/job';
import { JobRegistry } from './job-registry';

/** Una tarea va con retraso si su tick lleva más de esto × su periodo sin correr. */
export const SCHEDULE_OVERDUE_PERIODS = 2;

export interface ScheduleStatus {
  name: string;
  cron: string;
  lastRunAt: Date | null;
  /** null: ningún worker la ha sincronizado aún (no hay fila en job_schedules). */
  nextRunAt: Date | null;
  /** Intervalo entre su próximo tick y el siguiente, en ms. */
  periodMs: number;
  /** `now − nextRunAt` si ya pasó (0 si no). */
  delayMs: number;
  /** Más de 2 periodos sin correr, o nunca sincronizada. */
  overdue: boolean;
  /** DX-380: no encola un tick mientras el anterior siga en curso. */
  singleton: boolean;
  /** DX-380: ticks saltados por `singleton` (0 sin fila). */
  skippedCount: number;
  lastSkippedAt: Date | null;
}

export interface JobsStats {
  generatedAt: Date;
  queue: {
    pendingDue: number;
    pendingScheduled: number;
    /** `now − min(runAt)` de los PENDING vencidos, en ms (0 si no hay). */
    lagMs: number;
    oldestDueRunAt: Date | null;
    running: number;
    runningExpired: number;
    failedLast24h: number;
  };
  workers: {
    /** Latido de menos de 60 s. */
    alive: number;
    lastBeatAt: Date | null;
    recent: WorkerRow[];
  };
  schedules: ScheduleStatus[];
}

/**
 * Operación de la cola para la plataforma (superadmin): la cola de fallidos,
 * el estado (DX-220: profundidad, retraso, workers vivos y tareas
 * programadas) y el reencolado de un fallido. Solo ids, contadores y fechas:
 * nunca payloads.
 */
@Injectable()
export class JobsAdmin {
  private readonly logger = new Logger('Jobs');

  constructor(
    @Inject(JOB_REPOSITORY) private readonly repo: JobRepository,
    private readonly registry: JobRegistry,
  ) {}

  listFailed(limit: number): Promise<FailedJob[]> {
    return this.repo.listFailed(limit);
  }

  async stats(): Promise<JobsStats> {
    const snap = await this.repo.snapshot();
    const now = snap.now.getTime();
    const rows = new Map(snap.schedules.map((s) => [s.name, s]));
    // Las de este proceso y las que haya en la BD (el cron de la fila manda:
    // es el que dispara).
    const crons = new Map<string, string>([
      ...this.registry.schedules().map((s) => [s.name, s.cron] as const),
      ...snap.schedules.map((s) => [s.name, s.cron] as const),
    ]);
    // `singleton` es de la definición de este proceso (no se guarda en la BD).
    const singletons = new Set(
      this.registry
        .schedules()
        .filter((s) => s.singleton)
        .map((s) => s.name),
    );
    const schedules = [...crons]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, cron]): ScheduleStatus => {
        const row = rows.get(name);
        // Periodo alrededor del tick pendiente (crons irregulares, como
        // «lunes a viernes», dan el hueco de ESE tick).
        const anchor = row?.nextRunAt ?? snap.now;
        const tick = parseCron(cron).next(new Date(anchor.getTime() - 1));
        const periodMs = parseCron(cron).next(tick).getTime() - tick.getTime();
        if (!row) {
          // Ningún worker la sincronizó: no corre (worker caído desde antes
          // del despliegue, o réplicas antiguas).
          return {
            name,
            cron,
            lastRunAt: null,
            nextRunAt: null,
            periodMs,
            delayMs: 0,
            overdue: true,
            singleton: singletons.has(name),
            skippedCount: 0,
            lastSkippedAt: null,
          };
        }
        const delayMs = Math.max(0, now - row.nextRunAt.getTime());
        return {
          name,
          cron,
          lastRunAt: row.lastRunAt,
          nextRunAt: row.nextRunAt,
          periodMs,
          delayMs,
          overdue: delayMs > SCHEDULE_OVERDUE_PERIODS * periodMs,
          singleton: singletons.has(name),
          skippedCount: row.skippedCount,
          lastSkippedAt: row.lastSkippedAt,
        };
      });
    const alive = snap.workers.filter((w) => w.alive);
    const lastBeat = snap.workers[0]?.lastBeatAt ?? null;
    return {
      generatedAt: snap.now,
      queue: {
        pendingDue: snap.pendingDue,
        pendingScheduled: snap.pendingScheduled,
        lagMs: snap.oldestDueRunAt
          ? Math.max(0, now - snap.oldestDueRunAt.getTime())
          : 0,
        oldestDueRunAt: snap.oldestDueRunAt,
        running: snap.running,
        runningExpired: snap.runningExpired,
        failedLast24h: snap.failedLast24h,
      },
      workers: {
        alive: alive.length,
        lastBeatAt: lastBeat,
        recent: snap.workers,
      },
      schedules,
    };
  }

  /** Reencola un FAILED (attempts 0) y lo audita en platform_audit_events. */
  async retry(id: string, actor: PlatformActor): Promise<RetryResult> {
    const result = await this.repo.retryFailed(id, actor);
    if (result.status === 'retried') {
      this.logger.log({
        event: 'jobs.retried',
        jobId: result.job.id,
        job: result.job.name,
        tenantId: result.job.tenantId,
        actorUserId: actor.userId,
      });
    }
    return result;
  }
}
