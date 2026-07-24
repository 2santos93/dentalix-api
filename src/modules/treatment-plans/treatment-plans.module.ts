import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TreatmentPlansController } from './presentation/treatment-plans.controller';
import { CreateTreatmentPlanUseCase } from './application/use-cases/create-treatment-plan.use-case';
import { ListTreatmentPlansUseCase } from './application/use-cases/list-treatment-plans.use-case';
import { GetTreatmentPlanUseCase } from './application/use-cases/get-treatment-plan.use-case';
import { UpdateTreatmentPlanUseCase } from './application/use-cases/update-treatment-plan.use-case';
import { AddTreatmentPlanItemUseCase } from './application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from './application/use-cases/update-treatment-plan-item.use-case';
import { RemoveTreatmentPlanItemUseCase } from './application/use-cases/remove-treatment-plan-item.use-case';
import { TREATMENT_PLAN_REPOSITORY } from './domain/ports/treatment-plan-repository.port';
import { PrismaTreatmentPlanRepository } from './infrastructure/repositories/prisma-treatment-plan.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { DentalCatalogModule } from '../dental-catalog/dental-catalog.module';

@Module({
  // JwtModule.register({}) mirrors AppointmentsModule/OdontogramModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  // DentalCatalogModule is imported (not re-implemented) so
  // AddTreatmentPlanItemUseCase can inject DENTAL_CATALOG_REPOSITORY — it now
  // exports that provider (see dental-catalog.module.ts) for exactly this
  // cross-module use case.
  imports: [JwtModule.register({}), DentalCatalogModule],
  controllers: [TreatmentPlansController],
  providers: [
    CreateTreatmentPlanUseCase,
    ListTreatmentPlansUseCase,
    GetTreatmentPlanUseCase,
    UpdateTreatmentPlanUseCase,
    AddTreatmentPlanItemUseCase,
    UpdateTreatmentPlanItemUseCase,
    RemoveTreatmentPlanItemUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on TreatmentPlansController.
    TenantContextInterceptor,
    {
      provide: TREATMENT_PLAN_REPOSITORY,
      useClass: PrismaTreatmentPlanRepository,
    },
  ],
})
export class TreatmentPlansModule {}
