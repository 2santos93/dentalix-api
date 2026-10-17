import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobRegistry } from './application/job-registry';
import { JobQueue } from './application/job-queue.service';
import { JobWorker } from './application/job-worker.service';
import { JobsAdmin } from './application/jobs-admin.service';
import { JobsMaintenance } from './application/jobs-maintenance';
import { JOB_REPOSITORY } from './domain/job-repository.port';
import { JOBS_CONFIG, loadJobsConfig } from './infrastructure/jobs-config';
import type { JobsConfig } from './infrastructure/jobs-config';
import { PrismaJobRepository } from './infrastructure/prisma-job.repository';
import { JobsHealthServer } from './infrastructure/jobs-health-server';

/**
 * Trabajos en segundo plano sobre Postgres (DX-085): cola con outbox,
 * reintentos con backoff, cola de fallidos y tareas programadas con un solo
 * ejecutor por tick. DX-220: latido de los workers, estado de la cola para la
 * plataforma, reencolado de fallidos y sonda de liveness del worker. Los módulos que encolan o registran handlers importan
 * este módulo y usan `JobQueue.enqueue` / `JobRegistry.register|schedule` (en
 * su `onModuleInit`).
 *
 * NO es @Global a propósito: así Nest lo destruye ANTES que PrismaModule
 * (global, el último), y el apagado del worker puede esperar a los trabajos
 * en curso con la conexión aún abierta.
 */
@Module({
  providers: [
    {
      provide: JOBS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): JobsConfig =>
        loadJobsConfig((key) => config.get<string>(key)),
    },
    { provide: JOB_REPOSITORY, useClass: PrismaJobRepository },
    JobRegistry,
    JobQueue,
    JobWorker,
    JobsAdmin,
    JobsMaintenance,
    JobsHealthServer,
  ],
  exports: [JobRegistry, JobQueue, JobWorker, JobsAdmin, JOBS_CONFIG],
})
export class JobsModule {}
