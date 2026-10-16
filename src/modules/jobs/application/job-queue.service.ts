import { Inject, Injectable } from '@nestjs/common';
import { JOB_REPOSITORY } from '../domain/job-repository.port';
import type { JobRepository } from '../domain/job-repository.port';
import type { EnqueueOptions, EnqueueResult, JobPayload } from '../domain/job';
import { JOBS_CONFIG } from '../infrastructure/jobs-config';
import type { JobsConfig } from '../infrastructure/jobs-config';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
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
 *
 * Clínica del trabajo (revisión DX-085 H2/H3): la del contexto de la petición
 * o, si no hay, la de la transacción; con `tenantId` explícito, tiene que
 * coincidir con ambas. Con contexto de clínica, `tx` es obligatoria (o
 * `outsideTransaction: true` a propósito): nada de trabajos que se escapan
 * del outbox o que quedan sin clínica en silencio.
 */
@Injectable()
export class JobQueue {
  constructor(
    @Inject(JOB_REPOSITORY) private readonly repo: JobRepository,
    private readonly registry: JobRegistry,
    @Inject(JOBS_CONFIG) private readonly config: JobsConfig,
    private readonly tenantContext: TenantContextService,
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
    const tenantId = await this.resolveTenant(name, options);
    return this.repo.insert(
      {
        name,
        payload,
        tenantId,
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

  private async resolveTenant(
    name: string,
    options: EnqueueOptions,
  ): Promise<string | null> {
    const fromContext = this.tenantContext.getTenantId() ?? null;
    if (fromContext && !options.tx && !options.outsideTransaction) {
      throw new Error(
        `Trabajo "${name}": encolar dentro de una petición de clínica exige \`tx\` (la transacción de runWithTenant: outbox); si de verdad no hay nada que confirmar junto al trabajo, pasa outsideTransaction: true`,
      );
    }
    const fromTx = options.tx
      ? await this.repo.transactionTenant(options.tx)
      : null;
    const sources: (string | null)[] = [];
    if (options.tenantId !== undefined) sources.push(options.tenantId);
    if (fromContext) sources.push(fromContext);
    if (fromTx) sources.push(fromTx);
    if (new Set(sources).size > 1) {
      throw new Error(
        `Trabajo "${name}": la clínica del trabajo no coincide con la del contexto o la de la transacción`,
      );
    }
    return sources[0] ?? null;
  }
}
