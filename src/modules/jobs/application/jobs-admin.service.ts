import { Inject, Injectable } from '@nestjs/common';
import { JOB_REPOSITORY } from '../domain/job-repository.port';
import type { JobRepository } from '../domain/job-repository.port';
import type { FailedJob } from '../domain/job';

/** Operación de la cola para la plataforma (superadmin): fallidos y reintento. */
@Injectable()
export class JobsAdmin {
  constructor(@Inject(JOB_REPOSITORY) private readonly repo: JobRepository) {}

  listFailed(limit: number): Promise<FailedJob[]> {
    return this.repo.listFailed(limit);
  }

  /** Devuelve un fallido a la cola con sus intentos a cero. */
  retry(id: string): Promise<boolean> {
    return this.repo.retryFailed(id);
  }
}
