import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../shared/tenancy/tenant-context.service';
import { ClosingQueueUseCases } from '../closing-queue/application/closing-queue.use-cases';
import { ClosingQueueModule } from '../closing-queue/closing-queue.module';
import { ListInventoryItemsUseCase } from '../inventory/application/use-cases/list-inventory-items.use-case';
import { InventoryModule } from '../inventory/inventory.module';
import { CountAnamnesisInboxUseCase } from '../medical-history-submissions/application/use-cases/anamnesis-review.use-cases';
import { MedicalHistorySubmissionsModule } from '../medical-history-submissions/medical-history-submissions.module';
import { GetReceivablesAgingUseCase } from '../receivables/application/use-cases/get-receivables-aging.use-case';
import { ListDueRecallsUseCase } from '../recall/application/use-cases/recall.use-cases';
import { RecallModule } from '../recall/recall.module';
import { ReceivablesModule } from '../receivables/receivables.module';
import { PlanVisitsService } from '../treatment-plans/application/plan-visits.service';
import { ListPendingFollowUpUseCase } from '../treatment-plans/application/use-cases/list-pending-follow-up.use-case';
import { TreatmentPlansModule } from '../treatment-plans/treatment-plans.module';
import { ListWaitlistUseCase } from '../waitlist/application/use-cases/waitlist.use-cases';
import { WaitlistModule } from '../waitlist/waitlist.module';
import { workQueueSources } from './application/work-queue-sources';
import {
  WORK_QUEUES_CACHE_TTL_MS,
  WorkQueuesSummaryCache,
} from './application/work-queues-summary.cache';
import {
  GetWorkQueuesSummaryUseCase,
  WORK_QUEUE_SOURCES,
  WORK_QUEUES_CLOCK,
  type WorkQueuesClock,
} from './application/work-queues-summary.use-case';
import { WorkQueuesController } from './presentation/work-queues.controller';

/**
 * «Mi día» (DX-503): agrega los recuentos de las listas que ya existen. No
 * tiene tablas ni repositorio propios: cada módulo exporta el caso de uso de
 * su `/count` y aquí solo se reparten por rol y se ejecutan, de dos en dos y
 * con una caché corta (OPS-056).
 */
@Module({
  imports: [
    JwtModule.register({}),
    ClosingQueueModule,
    MedicalHistorySubmissionsModule,
    TreatmentPlansModule,
    WaitlistModule,
    RecallModule,
    ReceivablesModule,
    InventoryModule,
  ],
  controllers: [WorkQueuesController],
  providers: [
    GetWorkQueuesSummaryUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: WORK_QUEUES_CLOCK, useValue: () => new Date() },
    // OPS-056: una por réplica (proveedor único del módulo).
    {
      provide: WorkQueuesSummaryCache,
      inject: [WORK_QUEUES_CLOCK],
      useFactory: (clock: WorkQueuesClock) =>
        new WorkQueuesSummaryCache(WORK_QUEUES_CACHE_TTL_MS, () =>
          clock().getTime(),
        ),
    },
    {
      provide: WORK_QUEUE_SOURCES,
      inject: [
        ClosingQueueUseCases,
        CountAnamnesisInboxUseCase,
        ListPendingFollowUpUseCase,
        PlanVisitsService,
        ListWaitlistUseCase,
        ListDueRecallsUseCase,
        GetReceivablesAgingUseCase,
        ListInventoryItemsUseCase,
        TenantContextService,
      ],
      useFactory: (
        closingQueue: ClosingQueueUseCases,
        anamnesis: CountAnamnesisInboxUseCase,
        followUp: ListPendingFollowUpUseCase,
        visits: PlanVisitsService,
        waitlist: ListWaitlistUseCase,
        recall: ListDueRecallsUseCase,
        receivables: GetReceivablesAgingUseCase,
        inventory: ListInventoryItemsUseCase,
        tenantContext: TenantContextService,
      ) =>
        workQueueSources({
          closingQueue,
          anamnesis,
          followUp,
          visits,
          waitlist,
          recall,
          receivables,
          inventory,
          tenantContext,
        }),
    },
  ],
})
export class WorkQueuesModule {}
