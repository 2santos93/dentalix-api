import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { describeJobError, jobRetryDelayMs } from '../domain/backoff';
import { parseCron } from '../domain/cron';
import type { ClaimedJob, JobContext } from '../domain/job';
import { JOB_REPOSITORY } from '../domain/job-repository.port';
import type { JobRepository } from '../domain/job-repository.port';
import { JOBS_CONFIG } from '../infrastructure/jobs-config';
import type { JobsConfig } from '../infrastructure/jobs-config';
import { JobRegistry } from './job-registry';
import { WorkerLiveness } from './worker-liveness';

/** Tope de filas que failExhausted cierra por vuelta. */
const EXHAUSTED_BATCH = 100;

/**
 * Worker de la cola (DX-085). Arranca solo con `APP_ROLE=worker|all`
 * (`config.workerEnabled`); en la API (`api`) no hace nada.
 *
 * Cada vuelta (cada JOBS_POLL_INTERVAL_MS):
 * 0. late en `job_workers` (DX-220; solo el bucle, no `runOnce`);
 * 1. sincroniza las tareas programadas nuevas o con otro cron;
 * 2. dispara las que vencieron (un solo worker por tick, ver el repositorio);
 * 3. cierra como FAILED `LeaseExpired` los RUNNING vencidos sin intentos
 *    (DX-220, OPS-030: `failExhausted`), para que no envenenen el reclamo;
 * 4. reclama hasta JOBS_CONCURRENCY trabajos (SKIP LOCKED) y los ejecuta.
 *
 * Al final de cada vuelta apunta su liveness (`WorkerLiveness`), que lee la
 * sonda `GET /health` de JOBS_HEALTH_PORT (JobsHealthServer).
 *
 * Un trabajo con `tenantId` corre dentro de `TenantContextService.run`, así
 * que el handler usa `runWithTenant(fn)` y la RLS lo ata a esa clínica. Un
 * fallo suma el intento y lo reprograma con backoff exponencial; el último lo
 * deja FAILED (cola de fallidos, GET /platform/jobs/failed). La entrega es
 * «al menos una vez» (un worker que muere a mitad deja el trabajo para cuando
 * venza su arriendo): los handlers deben ser idempotentes.
 *
 * Apagado ordenado (SIGTERM con `enableShutdownHooks`): deja de reclamar y
 * espera a los trabajos en curso hasta JOBS_SHUTDOWN_GRACE_MS. Vive en un
 * módulo NO global para que Nest lo destruya antes que PrismaModule (global).
 */
interface RunningAttempt {
  attempts: number;
  abort: AbortController;
  /** Este proceso ya no es dueño del intento: no se cierra. */
  lost: boolean;
}

@Injectable()
export class JobWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly inFlight = new Set<Promise<void>>();
  /** Intentos en curso en este proceso, para el latido y el apagado. */
  private readonly running = new Map<string, RunningAttempt>();
  private readonly synced = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  /** Liveness del bucle (DX-220): la lee la sonda del worker. */
  readonly liveness: WorkerLiveness;

  constructor(
    private readonly registry: JobRegistry,
    @Inject(JOB_REPOSITORY) private readonly repo: JobRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(JOBS_CONFIG) private readonly config: JobsConfig,
  ) {
    this.liveness = new WorkerLiveness(config.pollIntervalMs);
  }

  onApplicationBootstrap(): void {
    if (this.config.workerEnabled) {
      this.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.logger.log({
      event: 'jobs.worker_started',
      workerId: this.config.workerId,
      role: this.config.role,
      handlers: this.registry.names(),
      schedules: this.registry.schedules().map((s) => s.name),
    });
    this.liveness.started();
    // Umbral de la sonda: lo más que puede tardar una sentencia legítima.
    // Sin esperar: si la BD no responde, el umbral se queda sin ese margen.
    this.repo.statementTimeoutMs().then(
      (ms) => this.liveness.setStatementTimeoutMs(ms),
      (err: unknown) =>
        this.logger.warn({
          event: 'jobs.statement_timeout_unknown',
          error: describeJobError(err),
        }),
    );
    this.scheduleNext(0);
  }

  isStopping(): boolean {
    return this.stopping;
  }

  /** Deja de reclamar y espera a los trabajos en curso (con tope). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.liveness.stopped();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.loop) {
      // Con tope (DX-220): una vuelta bloqueada (la BD no contesta) no puede
      // retener el apagado más que la gracia.
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        this.loop,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, this.config.shutdownGraceMs);
        }),
      ]);
      clearTimeout(grace);
    }
    if (this.inFlight.size > 0) {
      await this.drainInFlight();
    }
    if (this.started) {
      this.logger.log({
        event: 'jobs.worker_stopped',
        workerId: this.config.workerId,
      });
    }
  }

  private async drainInFlight(): Promise<void> {
    this.logger.log({
      event: 'jobs.worker_draining',
      workerId: this.config.workerId,
      inFlight: this.inFlight.size,
    });
    let grace: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      Promise.allSettled([...this.inFlight]).then(() => true),
      new Promise<boolean>((resolve) => {
        grace = setTimeout(() => resolve(false), this.config.shutdownGraceMs);
      }),
    ]);
    clearTimeout(grace);
    if (!finished) {
      // Lo que quede vuelve a PENDING ya (con fencing), sin esperar a que
      // venza el arriendo; su handler recibe abort y su cierre no cuenta.
      this.logger.warn({
        event: 'jobs.shutdown_grace_expired',
        workerId: this.config.workerId,
        inFlight: this.inFlight.size,
      });
      await Promise.all(
        [...this.running.entries()].map(async ([id, attempt]) => {
          if (attempt.lost) return;
          attempt.lost = true;
          attempt.abort.abort();
          try {
            await this.repo.reschedule(
              id,
              attempt.attempts,
              0,
              'ShutdownInterrupted',
            );
          } catch (err) {
            this.logger.warn({
              event: 'jobs.release_failed',
              jobId: id,
              error: describeJobError(err),
            });
          }
        }),
      );
    }
  }

  /**
   * Una vuelta completa esperando a sus trabajos: tareas programadas,
   * reclamo y ejecución. Devuelve cuántos trabajos ejecutó. La usa el bucle
   * del worker a través de `poll` y los tests para avanzar sin timers.
   */
  async runOnce(): Promise<number> {
    if (this.stopping) return 0;
    await this.prepare();
    const claimed = await this.claim(this.config.concurrency);
    await Promise.all(claimed.map((job) => this.execute(job)));
    return claimed.length;
  }

  /** Vueltas hasta que no quede nada vencido (tests y seed). */
  async drain(): Promise<void> {
    while ((await this.runOnce()) > 0) {
      // sigue
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.loop = this.poll()
        .catch(() => this.config.pollIntervalMs)
        .then((next) => {
          this.loop = null;
          this.scheduleNext(next);
        });
    }, delayMs);
  }

  /** Una vuelta del bucle sin esperar a los trabajos; devuelve la próxima espera. */
  private async poll(): Promise<number> {
    try {
      await this.beatWorker();
      await this.prepare();
      const free = this.config.concurrency - this.inFlight.size;
      if (free <= 0) return this.config.pollIntervalMs;
      const claimed = await this.claim(free);
      for (const job of claimed) {
        const running = this.execute(job).finally(() => {
          // Set en memoria (no la BD): la regla de borrado duro no aplica.
          // eslint-disable-next-line no-restricted-syntax
          this.inFlight.delete(running);
        });
        this.inFlight.add(running);
      }
      // Si había más trabajo del que cabía, la siguiente vuelta va enseguida.
      return claimed.length === free ? 0 : this.config.pollIntervalMs;
    } catch (err) {
      // La BD caída no tumba el worker: lo intenta en la siguiente vuelta.
      this.logger.warn({
        event: 'jobs.poll_failed',
        error: describeJobError(err),
      });
      return this.config.pollIntervalMs;
    } finally {
      this.liveness.loopFinished();
    }
  }

  /** Latido del proceso en job_workers; si falla, la vuelta sigue. */
  private async beatWorker(): Promise<void> {
    if (this.config.role === 'api') return;
    try {
      await this.repo.beat({
        id: this.config.workerId,
        role: this.config.role,
        version: this.config.version,
      });
    } catch (err) {
      this.logger.warn({
        event: 'jobs.worker_beat_failed',
        workerId: this.config.workerId,
        error: describeJobError(err),
      });
    }
  }

  /** Tareas programadas y cierre de los agotados: antes de cada reclamo. */
  private async prepare(): Promise<void> {
    await this.runSchedules();
    await this.failExhausted();
  }

  private async failExhausted(): Promise<void> {
    const exhausted = await this.repo.failExhausted(EXHAUSTED_BATCH);
    for (const job of exhausted) {
      // Su último intento se quedó a medias (el worker murió o su cierre
      // falló): no se repite.
      this.logger.warn({
        event: 'jobs.failed',
        jobId: job.id,
        job: job.name,
        tenantId: job.tenantId,
        attempt: job.attempts,
        error: 'LeaseExpired',
      });
    }
  }

  private async runSchedules(): Promise<void> {
    const schedules = this.registry.schedules();
    const pending = schedules.filter((s) => !this.synced.has(s.name));
    if (pending.length > 0) {
      await this.repo.syncSchedules(
        pending.map((s) => {
          const cron = parseCron(s.cron);
          return {
            name: s.name,
            cron: s.cron,
            firstRunAfter: (now: Date) => cron.next(now),
          };
        }),
      );
      for (const s of pending) this.synced.add(s.name);
    }
    if (schedules.length === 0) return;
    const fired = await this.repo.fireDueSchedules(
      schedules.map((s) => {
        const cron = parseCron(s.cron);
        return {
          name: s.name,
          cron: s.cron,
          job: s.job,
          payload: s.payload,
          maxAttempts:
            this.registry.get(s.job)?.maxAttempts ?? this.config.maxAttempts,
          nextRunAfter: (now: Date) => cron.next(now),
        };
      }),
    );
    if (fired > 0) {
      this.logger.log({ event: 'jobs.schedules_fired', count: fired });
    }
  }

  private claim(limit: number): Promise<ClaimedJob[]> {
    return this.repo.claim(
      this.registry.names(),
      limit,
      this.config.leaseSeconds,
      this.config.workerId,
    );
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const fields = {
      jobId: job.id,
      job: job.name,
      tenantId: job.tenantId,
      attempt: job.attempts,
    };
    try {
      const definition = this.registry.get(job.name);
      if (!definition) {
        await this.repo.fail(job.id, job.attempts, 'UnknownJob');
        return;
      }
      if (job.attempts > job.maxAttempts) {
        // Su último intento se quedó a medias (el worker murió): no se repite.
        await this.repo.fail(job.id, job.attempts, 'LeaseExpired');
        this.logger.warn({
          event: 'jobs.failed',
          ...fields,
          error: 'LeaseExpired',
        });
        return;
      }
      const attempt: RunningAttempt = {
        attempts: job.attempts,
        abort: new AbortController(),
        lost: false,
      };
      const context: JobContext = {
        jobId: job.id,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        tenantId: job.tenantId,
        signal: attempt.abort.signal,
      };
      const startedAt = Date.now();
      this.running.set(job.id, attempt);
      // Latido: mientras el handler trabaja, el arriendo no vence.
      const heartbeat = setInterval(
        () => void this.beat(job, attempt),
        this.config.heartbeatMs,
      );
      let failure: unknown = null;
      let failed = false;
      try {
        await (job.tenantId
          ? this.tenantContext.run(job.tenantId, () =>
              definition.handle(job.payload, context),
            )
          : definition.handle(job.payload, context));
      } catch (err) {
        failed = true;
        failure = err;
      } finally {
        clearInterval(heartbeat);
        // Map en memoria (no la BD): la regla de borrado duro no aplica.
        // eslint-disable-next-line no-restricted-syntax
        this.running.delete(job.id);
      }
      if (attempt.lost) {
        // Otro worker retomó el intento (o el apagado lo devolvió a la
        // cola): su resultado no cuenta y no se cierra nada.
        this.logger.warn({ event: 'jobs.attempt_lost', ...fields });
        return;
      }
      if (failed) {
        const error = describeJobError(failure);
        if (job.attempts >= job.maxAttempts) {
          await this.repo.fail(job.id, job.attempts, error);
          this.logger.warn({ event: 'jobs.failed', ...fields, error });
        } else {
          const delayMs = jobRetryDelayMs(
            job.attempts,
            definition.retryBaseMs ?? this.config.retryBaseMs,
          );
          await this.repo.reschedule(job.id, job.attempts, delayMs, error);
          this.logger.warn({
            event: 'jobs.retry_scheduled',
            ...fields,
            error,
            delayMs,
          });
        }
        return;
      }
      await this.repo.complete(job.id, job.attempts);
      this.logger.log({
        event: 'jobs.completed',
        ...fields,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      // No se pudo cerrar el intento (BD caída): al vencer el arriendo, otro
      // worker lo retoma.
      this.logger.error({
        event: 'jobs.settle_failed',
        ...fields,
        error: describeJobError(err),
      });
    }
  }

  /** Renueva el arriendo; si el intento ya no es de este worker, aborta. */
  private async beat(job: ClaimedJob, attempt: RunningAttempt): Promise<void> {
    if (attempt.lost) return;
    let renewed: boolean;
    try {
      renewed = await this.repo.heartbeat(
        job.id,
        attempt.attempts,
        this.config.leaseSeconds,
      );
    } catch (err) {
      // BD caída un momento: el siguiente latido lo vuelve a intentar.
      this.logger.warn({
        event: 'jobs.heartbeat_failed',
        jobId: job.id,
        error: describeJobError(err),
      });
      return;
    }
    if (!renewed && !attempt.lost) {
      attempt.lost = true;
      attempt.abort.abort();
    }
  }
}
