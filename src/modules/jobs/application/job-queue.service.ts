import { Inject, Injectable } from '@nestjs/common';
import { JOB_REPOSITORY } from '../domain/job-repository.port';
import type { JobRepository } from '../domain/job-repository.port';
import type { EnqueueOptions, EnqueueResult, JobPayload } from '../domain/job';
import { JOBS_CONFIG } from '../infrastructure/jobs-config';
import type { JobsConfig } from '../infrastructure/jobs-config';
import { JobRegistry } from './job-registry';

function isPlainObject(value: unknown): value is JobPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Encolar un trabajo (DX-085). Pasando `tx` (la transacción de negocio de
 * `runWithTenant`), el trabajo se inserta en ELLA: si el negocio hace
 * rollback, no existe; si hace commit, se ejecuta (patrón outbox). Sin `tx`,
 * se inserta en su propia sentencia.
 *
 * ```ts
 * await this.prisma.runWithTenant(async (tx) => {
 *   const appt = await tx.appointment.create({ ... });
 *   await this.jobs.enqueue('reminders.send', { appointmentId: appt.id }, {
 *     tx,
 *     runAt: reminderAt,
 *     idempotencyKey: `reminder:${appt.id}:24h`,
 *   });
 * });
 * ```
 *
 * El payload lleva SOLO ids: el handler relee lo demás bajo el tenant.
 */
@Injectable()
export class JobQueue {
  constructor(
    @Inject(JOB_REPOSITORY) private readonly repo: JobRepository,
    private readonly registry: JobRegistry,
    @Inject(JOBS_CONFIG) private readonly config: JobsConfig,
  ) {}

  async enqueue<P extends JobPayload>(
    name: string,
    payload: P,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    const definition = this.registry.get(name);
    if (!definition) {
      throw new Error(
        `Trabajo "${name}" no registrado: regístralo en su módulo con JobRegistry.register`,
      );
    }
    if (!isPlainObject(payload)) {
      throw new Error(
        `Trabajo "${name}": el payload debe ser un objeto con ids`,
      );
    }
    return this.repo.insert(
      {
        name,
        payload,
        tenantId: options.tenantId,
        runAt: options.runAt,
        idempotencyKey: options.idempotencyKey,
        maxAttempts:
          options.maxAttempts ??
          definition.maxAttempts ??
          this.config.maxAttempts,
      },
      options.tx,
    );
  }
}
