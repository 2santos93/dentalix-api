import { Module } from '@nestjs/common';
import { ExchangeModule } from '../exchange/exchange.module';
import { JobsModule } from '../jobs/jobs.module';
import { PaymentAllocationJobs } from './application/payment-allocation-jobs';
import { PaymentBaseRetries } from './application/payment-base-retries';
import { PAYMENT_BASE_RETRY_REPOSITORY } from './domain/ports/payment-base-retry-repository.port';
import { PrismaPaymentBaseRetryRepository } from './infrastructure/allocations/prisma-payment-base-retry.repository';
import { PlanAllocationRebalancer } from './application/plan-allocation-rebalancer';
import { PLAN_ALLOCATION_REPOSITORY } from './domain/ports/plan-allocation-repository.port';
import { PrismaPlanAllocationRepository } from './infrastructure/allocations/prisma-plan-allocation.repository';
import { DrainAllocationRebalancesInterceptor } from './presentation/drain-allocation-rebalances.interceptor';

/**
 * Reparto automático de abonos entre ítems (DX-051): el rebalanceador, su
 * repositorio, el interceptor que drena tras cada escritura, el barrido de
 * cada minuto y los reintentos escalonados de los abonos sin base (DX-380).
 * Módulo aparte de `PaymentsModule` porque lo importan también los módulos
 * cuyas rutas encolan (planes, cargo por inasistencia), y `PaymentsModule` ya
 * importa `TreatmentPlansModule`.
 */
@Module({
  imports: [ExchangeModule, JobsModule],
  providers: [
    {
      provide: PLAN_ALLOCATION_REPOSITORY,
      useClass: PrismaPlanAllocationRepository,
    },
    {
      provide: PAYMENT_BASE_RETRY_REPOSITORY,
      useClass: PrismaPaymentBaseRetryRepository,
    },
    PlanAllocationRebalancer,
    PaymentBaseRetries,
    DrainAllocationRebalancesInterceptor,
    PaymentAllocationJobs,
  ],
  exports: [
    PLAN_ALLOCATION_REPOSITORY,
    PlanAllocationRebalancer,
    PaymentBaseRetries,
    DrainAllocationRebalancesInterceptor,
  ],
})
export class PaymentAllocationsModule {}
