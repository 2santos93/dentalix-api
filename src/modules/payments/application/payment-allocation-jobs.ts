import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type PlanAllocationRepository,
} from '../domain/ports/plan-allocation-repository.port';
import { errorName } from './payment-in-plan-currency';
import { PlanAllocationRebalancer } from './plan-allocation-rebalancer';
import { ExchangeSourceChangeHooks } from '../../exchange/application/exchange-source-change-hooks';

export const ALLOCATIONS_SWEEP_JOB = 'payment-allocations.sweep';
/**
 * Cada minuto (un ejecutor por tick con N workers): recoge lo que el
 * interceptor no drenó (más de 5 planes, un fallo o un proceso caído),
 * congela la tasa de los abonos que se cobraron sin tasa en cuanto la hay
 * (DX-375) y crea sus bases.
 */
export const ALLOCATIONS_SWEEP_SCHEDULE =
  'payment-allocations.sweep.every-minute';
export const ALLOCATIONS_SWEEP_CRON = '* * * * *';
/**
 * Tasas y bases por clínica y pasada: la conversión puede pedir un proveedor
 * externo.
 */
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
    private readonly sourceChangeHooks: ExchangeSourceChangeHooks,
  ) {}

  onModuleInit(): void {
    // BE-047 (DX-375): antes de que la clínica del contexto cambie la fuente
    // de su tasa, todos sus abonos pendientes congelan la de antes.
    this.sourceChangeHooks.register(async () => {
      await this.rebalancer.freezeAllPending();
    });
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
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }

  /** Todas las clínicas; una que falla no deja sin barrido a las demás. */
  async sweep(): Promise<void> {
    for (const tenantId of await this.repo.tenantIds()) {
      await this.tenantContext.run(tenantId, async () => {
        // DX-375: antes que las bases, la tasa de los abonos que la esperan
        // («sin tasa» o anteriores): la base nace de la tasa congelada.
        try {
          await this.rebalancer.freezePendingRates(MISSING_BASES_PER_SWEEP);
        } catch (error) {
          this.logger.warn({
            event: 'payments.exchange_rates_freeze_failed',
            tenantId,
            error: errorName(error),
          });
        }
        try {
          await this.rebalancer.createMissingBases(MISSING_BASES_PER_SWEEP);
        } catch (error) {
          this.logger.warn({
            event: 'payments.allocation_bases_failed',
            tenantId,
            error: errorName(error),
          });
        }
        // Nunca lanza: cada plan que falla deja su propio aviso.
        await this.rebalancer.drainPending({ actorId: null });
      });
    }
  }
}
