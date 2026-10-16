import { Inject, Injectable } from '@nestjs/common';
import { JOB_REPOSITORY } from '../domain/job-repository.port';
import type { JobRepository } from '../domain/job-repository.port';
import type { FailedJob } from '../domain/job';

/** Operación de la cola para la plataforma (superadmin): la cola de fallidos. */
@Injectable()
export class JobsAdmin {
  constructor(@Inject(JOB_REPOSITORY) private readonly repo: JobRepository) {}

  listFailed(limit: number): Promise<FailedJob[]> {
    return this.repo.listFailed(limit);
  }
}
