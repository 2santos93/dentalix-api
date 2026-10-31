import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { errorName } from './payment-in-plan-currency';
import { PaymentBaseRetries } from './payment-base-retries';
import { PlanAllocationRebalancer } from './plan-allocation-rebalancer';
import { ExchangeSourceChangeHooks } from '../../exchange/application/exchange-source-change-hooks';
import { ProviderRatesCallerScope } from '../../exchange/application/provider-rates-caller-scope';

export const ALLOCATIONS_SWEEP_JOB = 'payment-allocations.sweep';
/**
 * Cada minuto (un ejecutor por tick con N workers, y nunca dos ticks a la
 * vez: `singleton`, DX-380): recoge lo que el interceptor no drenó (más de 5
 * planes, un fallo o un proceso caído) y reintenta los abonos que se quedaron
 * sin tasa o sin base, con su backoff (DX-375, DX-380).
 */
export const ALLOCATIONS_SWEEP_SCHEDULE =
  'payment-allocations.sweep.every-minute';
export const ALLOCATIONS_SWEEP_CRON = '* * * * *';
/**
 * Reintentos por clínica y pasada: la conversión puede pedir un proveedor
 * externo.
 */
export const MISSING_BASES_PER_SWEEP = 50;

/**
 * Barrido del reparto automático (DX-051, spec R9.3) en la cola de DX-085:
 * solo las clínicas con algo pendiente (DX-380: un reintento vencido o un
 * plan por repartir, en una sola consulta), cada una con su tenant en el
 * contexto: reintenta sus abonos sin base y drena sus solicitudes.
 * Idempotente; sin reintentos de la cola (la pasada siguiente es el
 * reintento).
 */
@Injectable()
export class PaymentAllocationJobs implements OnModuleInit {
  private readonly logger = new Logger('PaymentAllocations');

  constructor(
    private readonly registry: JobRegistry,
    private readonly rebalancer: PlanAllocationRebalancer,
    private readonly retries: PaymentBaseRetries,
    private readonly tenantContext: TenantContextService,
    private readonly sourceChangeHooks: ExchangeSourceChangeHooks,
    private readonly ratesCallerScope: ProviderRatesCallerScope,
  ) {}

  onModuleInit(): void {
    // BE-047 (DX-375): antes de que la clínica del contexto cambie la fuente
    // de su tasa, todos sus abonos pendientes congelan la de antes.
    this.sourceChangeHooks.register(async () => {
      await this.rebalancer.freezeAllPending();
    });
    // DX-380: con una tasa nueva (o la otra fuente) sus abonos aplazados se
    // intentan en el barrido siguiente, sin esperar a su backoff.
    this.sourceChangeHooks.registerAfterRatesChange(async () => {
      await this.retries.wake();
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

  /**
   * Clínicas con pendientes; una que falla no deja sin barrido a las demás.
   * SEC-058: sus llamadas al proveedor de tasas gastan del cupo reservado
   * del barrido, no del de las peticiones de la clínica.
   */
  async sweep(): Promise<void> {
    for (const tenantId of await this.retries.dueTenantIds()) {
      await this.tenantContext.run(tenantId, () =>
        this.ratesCallerScope.asSweep(() => this.sweepClinic(tenantId)),
      );
    }
  }

  private async sweepClinic(tenantId: string): Promise<void> {
    try {
      await this.retries.retryDue(MISSING_BASES_PER_SWEEP);
    } catch (error) {
      this.logger.warn({
        event: 'payments.allocation_retries_failed',
        tenantId,
        error: errorName(error),
      });
    }
    // Nunca lanza: cada plan que falla deja su propio aviso.
    await this.rebalancer.drainPending({ actorId: null });
  }
}
