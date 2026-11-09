import {
  AcceptanceRepricer,
  ApplyPlanRepricingUseCase,
  PreviewPlanRepricingUseCase,
  RepricingContextReader,
} from './application/use-cases/plan-repricing.use-cases';
import { PLAN_REPRICING_REPOSITORY } from './domain/ports/plan-repricing-repository.port';
import { PrismaPlanRepricingRepository } from './infrastructure/repositories/prisma-plan-repricing.repository';
import { PlanRepricingController } from './presentation/plan-repricing.controller';
import { QuoteExpiry } from './application/quote-expiry';
import {
  GetQuoteSettingsUseCase,
  UpdateQuoteSettingsUseCase,
} from './application/use-cases/quote-settings.use-cases';
import { QUOTE_SETTINGS_REPOSITORY } from './domain/ports/quote-settings-repository.port';
import { PrismaQuoteSettingsRepository } from './infrastructure/repositories/prisma-quote-settings.repository';
import { QuoteSettingsController } from './presentation/quote-settings.controller';
import { PLAN_QUOTE_ZONES } from './domain/ports/plan-quote-zones.port';
import { QUOTE_EXPIRY_REGIONAL } from './domain/ports/quote-expiry-regional.port';
import { PrismaQuoteExpiryRegional } from './infrastructure/adapters/prisma-quote-expiry-regional';
import { PrismaPlanQuoteZones } from './infrastructure/adapters/prisma-plan-quote-zones';
import { PlanVisitsService } from './application/plan-visits.service';
import { PlanVisitsController } from './presentation/plan-visits.controller';
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
  PreviewAcceptanceRepricingUseCase,
  PreviewPartialAcceptanceUseCase,
  GetPlanQuoteUseCase,
  IssuePlanQuoteUseCase,
  PLAN_QUOTE_CLOCK,
  PLAN_QUOTE_COMPOSITION,
} from './application/use-cases/plan-quote.use-cases';
import { loadPlanQuoteComposition } from './application/plan-quote-composition.config';
import { ConfigService } from '@nestjs/config';
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
import { PLAN_CURRENCY_SOURCE } from './domain/ports/plan-currency-source.port';
import { PrismaPlanCurrencySource } from './infrastructure/adapters/prisma-plan-currency-source.adapter';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { PaymentAllocationsModule } from '../payments/payment-allocations.module';
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
import { ExchangeModule } from '../exchange/exchange.module';
import { REFERENCE_RATE_SOURCE } from './domain/ports/reference-rate-source.port';
import { ClinicReferenceRateSource } from './infrastructure/pricing/clinic-reference-rate-source';

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
    DocumentTypeNamesModule,
    DiscountsModule,
    PriceListsModule,
    AgreementsModule,
    PatientAgreementsModule,
    // DX-051: las escrituras de ítems y planes drenan el reparto de abonos.
    PaymentAllocationsModule,
    // DX-513-bis: la tasa de la clínica para congelar la referencia de un
    // ítem en otra moneda (la misma lectura que los abonos).
    ExchangeModule,
  ],
  // PlanFollowUpController va PRIMERO: su `GET treatment-plans/pending-follow-up`
  // quedaría tapado por `GET treatment-plans/:id` si se registrara después.
  controllers: [
    PlanVisitsController,
    PlanFollowUpController,
    TreatmentPlansController,
    PlanQuoteController,
    // Precio resuelto de un ítem nuevo (DX-105).
    PriceQuoteController,
    // DX-379: días de validez del presupuesto de la clínica.
    QuoteSettingsController,
    // DX-379 (B): «Actualizar precios» (recotizar).
    PlanRepricingController,
  ],
  providers: [
    PlanVisitsService,
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
    // DX-513-bis: tasa de hoy en la sede de escritura para la referencia.
    { provide: REFERENCE_RATE_SOURCE, useClass: ClinicReferenceRateSource },
    GetPriceQuoteUseCase,
    // Alternativas, presentación, rechazo y seguimiento (DX-040).
    PresentTreatmentPlanUseCase,
    RejectTreatmentPlanUseCase,
    CreatePlanAlternativeUseCase,
    ListPendingFollowUpUseCase,
    { provide: TREATMENT_PLAN_CLOCK, useValue: () => new Date() },
    // DX-379: `quoteExpired` de los planes, con la zona de su sede.
    QuoteExpiry,
    { provide: PLAN_QUOTE_ZONES, useClass: PrismaPlanQuoteZones },
    { provide: QUOTE_EXPIRY_REGIONAL, useClass: PrismaQuoteExpiryRegional },
    GetQuoteSettingsUseCase,
    UpdateQuoteSettingsUseCase,
    // DX-379 (B): recotizar con el precio vigente.
    RepricingContextReader,
    AcceptanceRepricer,
    PreviewPlanRepricingUseCase,
    ApplyPlanRepricingUseCase,
    {
      provide: PLAN_REPRICING_REPOSITORY,
      useClass: PrismaPlanRepricingRepository,
    },
    {
      provide: QUOTE_SETTINGS_REPOSITORY,
      useClass: PrismaQuoteSettingsRepository,
    },
    { provide: PLAN_OPTIONS_REPOSITORY, useClass: PrismaPlanOptionsRepository },
    // Presupuesto imprimible y aceptación firmada (DX-012).
    GetPlanQuoteUseCase,
    IssuePlanQuoteUseCase,
    AcceptTreatmentPlanUseCase,
    PreviewAcceptanceRepricingUseCase,
    PreviewPartialAcceptanceUseCase,
    { provide: PLAN_QUOTE_CLOCK, useValue: () => new Date() },
    // DX-502: v4 o, con PLAN_QUOTE_COMPOSE_V4=false, como antes (v2/v3).
    {
      provide: PLAN_QUOTE_COMPOSITION,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loadPlanQuoteComposition((key) => config.get<string>(key)),
    },
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
    { provide: PLAN_CURRENCY_SOURCE, useClass: PrismaPlanCurrencySource },
  ],
  // Exported (additive) so PaymentsModule can inject GetTreatmentPlanUseCase
  // by class -- RecordPaymentUseCase/GetPlanBalanceUseCase need to read a
  // plan (+ its active items + currency) before recording/valuing a payment,
  // same cross-module DI pattern as ExchangeModule exporting
  // ConvertAmountUseCase for SalesModule/PaymentsModule.
  // DX-503: «Mi día» cuenta presupuestos por seguir y aceptados sin agendar
  // con los mismos casos de uso que sus `/count`.
  exports: [
    GetTreatmentPlanUseCase,
    ListPendingFollowUpUseCase,
    PlanVisitsService,
  ],
})
export class TreatmentPlansModule {}
