import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JOB_REPOSITORY } from '../domain/job-repository.port';
import type { JobRepository } from '../domain/job-repository.port';
import { JOBS_CONFIG } from '../infrastructure/jobs-config';
import type { JobsConfig } from '../infrastructure/jobs-config';
import { WORKER_RETENTION_DAYS } from '../domain/job';
import { JobRegistry } from './job-registry';

export const PURGE_FINISHED_JOB = 'jobs.purge-finished';
export const PURGE_FINISHED_SCHEDULE = 'jobs.purge-finished.daily';

/**
 * Mantenimiento de la propia cola: cada día borra los trabajos terminados
 * (COMPLETED y FAILED) de hace más de JOBS_RETENTION_DAYS. Mientras exista la
 * fila, su idempotencyKey sigue bloqueando un segundo enqueue. DX-220: y los
 * workers de job_workers que llevan más de 7 días sin latir.
 */
@Injectable()
export class JobsMaintenance implements OnModuleInit {
  private readonly logger = new Logger('Jobs');

  constructor(
    private readonly registry: JobRegistry,
    @Inject(JOB_REPOSITORY) private readonly repo: JobRepository,
    @Inject(JOBS_CONFIG) private readonly config: JobsConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: PURGE_FINISHED_JOB,
      maxAttempts: 3,
      handle: async () => {
        const before = new Date(
          Date.now() - this.config.retentionDays * 86_400_000,
        );
        const purged = await this.repo.purgeFinished(before);
        const purgedWorkers = await this.repo.purgeStaleWorkers(
          new Date(Date.now() - WORKER_RETENTION_DAYS * 86_400_000),
        );
        this.logger.log({ event: 'jobs.purged', purged, purgedWorkers });
      },
    });
    this.registry.schedule({
      name: PURGE_FINISHED_SCHEDULE,
      cron: '41 3 * * *',
      job: PURGE_FINISHED_JOB,
    });
  }
}
