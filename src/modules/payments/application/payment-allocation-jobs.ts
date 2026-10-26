import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type PlanAllocationRepository,
} from '../domain/ports/plan-allocation-repository.port';
import { PlanAllocationRebalancer } from './plan-allocation-rebalancer';

export const ALLOCATIONS_SWEEP_JOB = 'payment-allocations.sweep';
/**
 * Cada minuto (un ejecutor por tick con N workers): recoge lo que el
 * interceptor no drenó (más de 5 planes, un fallo o un proceso caído) y crea
 * las bases de los abonos que se cobraron sin tasa en cuanto la hay.
 */
export const ALLOCATIONS_SWEEP_SCHEDULE =
  'payment-allocations.sweep.every-minute';
export const ALLOCATIONS_SWEEP_CRON = '* * * * *';
/** Bases por clínica y pasada: la conversión puede pedir un proveedor externo. */
export const MISSING_BASES_PER_SWEEP = 50;

/**
 * Barrido del reparto automático (DX-051, spec R9.3) en la cola de DX-085:
 * clínica por clínica, con su tenant en el contexto, crea las bases que faltan
 * y drena sus solicitudes. Idempotente; sin reintentos de la cola (la pasada
 * siguiente es el reintento).
 */
@Injectable()
export class PaymentAllocationJobs implements OnModuleInit {
  private readonly logger = new Logger('PaymentAllocations');

  constructor(
    private readonly registry: JobRegistry,
    private readonly rebalancer: PlanAllocationRebalancer,
    @Inject(PLAN_ALLOCATION_REPOSITORY)
    private readonly repo: PlanAllocationRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: ALLOCATIONS_SWEEP_JOB,
      maxAttempts: 1,
      handle: async () => {
        await this.sweep();
      },
    });
    this.registry.schedule({
      name: ALLOCATIONS_SWEEP_SCHEDULE,
      cron: ALLOCATIONS_SWEEP_CRON,
      job: ALLOCATIONS_SWEEP_JOB,
    });
  }

  /** Todas las clínicas; una que falla no deja sin barrido a las demás. */
  async sweep(): Promise<void> {
    for (const tenantId of await this.repo.tenantIds()) {
      await this.tenantContext.run(tenantId, async () => {
        try {
          await this.rebalancer.createMissingBases(MISSING_BASES_PER_SWEEP);
        } catch (error) {
          this.logger.warn({
            event: 'payments.allocation_bases_failed',
            tenantId,
            error: error instanceof Error ? error.name : typeof error,
          });
        }
        // Nunca lanza: cada plan que falla deja su propio aviso.
        await this.rebalancer.drainPending({ actorId: null });
      });
    }
  }
}
