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
import { CURRENCY_WHITELIST } from './domain/ports/currency-whitelist.port';
import { PrismaCurrencyWhitelist } from './infrastructure/adapters/prisma-currency-whitelist.adapter';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';
import { DentalCatalogModule } from '../dental-catalog/dental-catalog.module';

@Module({
  // JwtModule.register({}) mirrors AppointmentsModule/OdontogramModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  // DentalCatalogModule is imported (not re-implemented) so
  // AddTreatmentPlanItemUseCase can inject DENTAL_CATALOG_REPOSITORY — it now
  // exports that provider (see dental-catalog.module.ts) for exactly this
  // cross-module use case. The DONE -> odontogram mirror (Pieza B) is written
  // by PrismaTreatmentPlanRepository.updateItem in the SAME transaction as the
  // status change (DX-042, DB-013), so no odontogram provider is injected.
  // PatientsModule exporta PATIENT_REPOSITORY: el use-case de alta valida que el
  // paciente de la ruta sea de esta clínica antes de insertar (SEC-004).
  imports: [JwtModule.register({}), DentalCatalogModule, PatientsModule],
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
    {
      provide: CURRENCY_WHITELIST,
      useClass: PrismaCurrencyWhitelist,
    },
  ],
  // Exported (additive) so PaymentsModule can inject GetTreatmentPlanUseCase
  // by class -- RecordPaymentUseCase/GetPlanBalanceUseCase need to read a
  // plan (+ its active items + currency) before recording/valuing a payment,
  // same cross-module DI pattern as ExchangeModule exporting
  // ConvertAmountUseCase for SalesModule/PaymentsModule.
  exports: [GetTreatmentPlanUseCase],
})
export class TreatmentPlansModule {}
