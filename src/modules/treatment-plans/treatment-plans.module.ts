import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TreatmentPlansController } from './presentation/treatment-plans.controller';
import { PlanFollowUpController } from './presentation/plan-follow-up.controller';
import { PresentTreatmentPlanUseCase } from './application/use-cases/present-treatment-plan.use-case';
import { RejectTreatmentPlanUseCase } from './application/use-cases/reject-treatment-plan.use-case';
import { CreatePlanAlternativeUseCase } from './application/use-cases/create-plan-alternative.use-case';
import { ListPendingFollowUpUseCase } from './application/use-cases/list-pending-follow-up.use-case';
import { TREATMENT_PLAN_CLOCK } from './application/plan-clock';
import { PLAN_OPTIONS_REPOSITORY } from './domain/ports/plan-options-repository.port';
import { PrismaPlanOptionsRepository } from './infrastructure/repositories/prisma-plan-options.repository';
import { PlanQuoteController } from './presentation/plan-quote.controller';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
  PLAN_QUOTE_CLOCK,
} from './application/use-cases/plan-quote.use-cases';
import { PLAN_QUOTE_REPOSITORY } from './domain/ports/plan-quote-repository.port';
import { PrismaPlanQuoteRepository } from './infrastructure/repositories/prisma-plan-quote.repository';
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
import { DiscountsModule } from '../discounts/discounts.module';
import { ApplyBulkDiscountUseCase } from './application/use-cases/apply-bulk-discount.use-case';
import { PriceListsModule } from '../price-lists/price-lists.module';
import { AgreementsModule } from '../agreements/agreements.module';
import { PatientAgreementsModule } from '../patient-agreements/patient-agreements.module';
import { PRICING_SOURCE } from './domain/ports/pricing-source.port';
import { PrismaPricingSource } from './infrastructure/pricing/prisma-pricing-source';
import { GetPriceQuoteUseCase } from './application/use-cases/get-price-quote.use-case';
import { PriceQuoteController } from './presentation/price-quote.controller';

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
  // DiscountsModule exporta la política de descuentos (DX-204), que los casos
  // de uso de los ítems aplican en el servidor.
  // DX-105: listas de precios, convenios y asignaciones exportan sus
  // repositorios para la resolución del precio de un ítem nuevo (PricingSource).
  imports: [
    JwtModule.register({}),
    DentalCatalogModule,
    PatientsModule,
    DiscountsModule,
    PriceListsModule,
    AgreementsModule,
    PatientAgreementsModule,
  ],
  // PlanFollowUpController va PRIMERO: su `GET treatment-plans/pending-follow-up`
  // quedaría tapado por `GET treatment-plans/:id` si se registrara después.
  controllers: [
    PlanFollowUpController,
    TreatmentPlansController,
    PlanQuoteController,
    // Precio resuelto de un ítem nuevo (DX-105).
    PriceQuoteController,
  ],
  providers: [
    CreateTreatmentPlanUseCase,
    ListTreatmentPlansUseCase,
    GetTreatmentPlanUseCase,
    UpdateTreatmentPlanUseCase,
    AddTreatmentPlanItemUseCase,
    UpdateTreatmentPlanItemUseCase,
    RemoveTreatmentPlanItemUseCase,
    // Acción «Descuento %» sobre varios ítems (DX-204).
    ApplyBulkDiscountUseCase,
    // Resolución del precio por convenio o lista (DX-105).
    { provide: PRICING_SOURCE, useClass: PrismaPricingSource },
    GetPriceQuoteUseCase,
    // Alternativas, presentación, rechazo y seguimiento (DX-040).
    PresentTreatmentPlanUseCase,
    RejectTreatmentPlanUseCase,
    CreatePlanAlternativeUseCase,
    ListPendingFollowUpUseCase,
    { provide: TREATMENT_PLAN_CLOCK, useValue: () => new Date() },
    { provide: PLAN_OPTIONS_REPOSITORY, useClass: PrismaPlanOptionsRepository },
    // Presupuesto imprimible y aceptación firmada (DX-012).
    GetPlanQuoteUseCase,
    AcceptTreatmentPlanUseCase,
    { provide: PLAN_QUOTE_CLOCK, useValue: () => new Date() },
    { provide: PLAN_QUOTE_REPOSITORY, useClass: PrismaPlanQuoteRepository },
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
