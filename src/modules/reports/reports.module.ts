import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { GetLocationsComparisonUseCase } from './application/use-cases/get-locations-comparison.use-case';
import { LOCATIONS_COMPARISON_REPOSITORY } from './domain/ports/locations-comparison-repository.port';
import { PrismaLocationsComparisonRepository } from './infrastructure/prisma-locations-comparison.repository';
import { LocationsComparisonController } from './presentation/locations-comparison.controller';
import { GetProductionByProcedureUseCase } from './application/use-cases/get-production-by-procedure.use-case';
import { PRODUCTION_BY_PROCEDURE_REPOSITORY } from './domain/ports/production-by-procedure-repository.port';
import { PrismaProductionByProcedureRepository } from './infrastructure/prisma-production-by-procedure.repository';
import { ProductionByProcedureController } from './presentation/production-by-procedure.controller';
import { GetUnallocatedPaymentsUseCase } from './application/use-cases/get-unallocated-payments.use-case';
import { UNALLOCATED_PAYMENTS_REPOSITORY } from './domain/ports/unallocated-payments-repository.port';
import { PrismaUnallocatedPaymentsRepository } from './infrastructure/prisma-unallocated-payments.repository';
import { UnallocatedPaymentsController } from './presentation/unallocated-payments.controller';
import { GetRecoveredSlotsUseCase } from './application/use-cases/get-recovered-slots.use-case';
import { RECOVERED_SLOTS_REPOSITORY } from './domain/ports/recovered-slots-repository.port';
import { PrismaRecoveredSlotsRepository } from './infrastructure/prisma-recovered-slots.repository';
import { RecoveredSlotsController } from './presentation/recovered-slots.controller';
import { GetChairOccupancyUseCase } from './application/use-cases/get-chair-occupancy.use-case';
import { CHAIR_OCCUPANCY_REPOSITORY } from './domain/ports/chair-occupancy-repository.port';
import { PrismaChairOccupancyRepository } from './infrastructure/prisma-chair-occupancy.repository';
import { ChairOccupancyController } from './presentation/chair-occupancy.controller';
import {
  GetPatientLinksUseCase,
  PATIENT_LINKS_CLOCK,
} from './application/use-cases/get-patient-links.use-case';
import { PATIENT_LINKS_REPOSITORY } from './domain/ports/patient-links-repository.port';
import { PrismaPatientLinksRepository } from './infrastructure/prisma-patient-links.repository';
import { PatientLinksController } from './presentation/patient-links.controller';
import { GetProfitabilityUseCase } from './application/use-cases/get-profitability.use-case';
import { PROFITABILITY_REPOSITORY } from './domain/ports/profitability-repository.port';
import { PrismaProfitabilityRepository } from './infrastructure/prisma-profitability.repository';
import { ProfitabilityController } from './presentation/profitability.controller';
import { GetQuoteFunnelUseCase } from './application/use-cases/get-quote-funnel.use-case';
import { QUOTE_FUNNEL_REPOSITORY } from './domain/ports/quote-funnel-repository.port';
import { PrismaQuoteFunnelRepository } from './infrastructure/prisma-quote-funnel.repository';
import { QuoteFunnelController } from './presentation/quote-funnel.controller';
import { CATALOG_CURRENCY_READER } from '../dental-catalog/domain/ports/catalog-currency-reader.port';
import { PrismaCatalogCurrencyReader } from '../dental-catalog/infrastructure/prisma-catalog-currency-reader';

// Reportes de gestión (DX-014). Pestañas: «Comparar sedes» (indicadores en
// `domain/kpi-definitions.ts`), «Producción por procedimiento» (DX-423) y
// «Cobrado sin imputar» (DX-399, ADMIN y recepción) y «Huecos recuperados»
// (DX-436), «Ocupación por sillón» (DX-481), «Enlaces del paciente»
// (DX-424), «Rentabilidad por sede» (DX-410) y «Embudo de presupuestos»
// (DX-558, con la moneda del catálogo de DX-502-ter); las
// siguientes se añaden como controladores bajo el mismo prefijo `reports`.
@Module({
  imports: [JwtModule.register({})],
  controllers: [
    LocationsComparisonController,
    ProductionByProcedureController,
    UnallocatedPaymentsController,
    RecoveredSlotsController,
    ChairOccupancyController,
    PatientLinksController,
    ProfitabilityController,
    QuoteFunnelController,
  ],
  providers: [
    GetLocationsComparisonUseCase,
    GetProductionByProcedureUseCase,
    GetUnallocatedPaymentsUseCase,
    GetRecoveredSlotsUseCase,
    GetChairOccupancyUseCase,
    GetPatientLinksUseCase,
    GetProfitabilityUseCase,
    GetQuoteFunnelUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: LOCATIONS_COMPARISON_REPOSITORY,
      useClass: PrismaLocationsComparisonRepository,
    },
    {
      provide: PRODUCTION_BY_PROCEDURE_REPOSITORY,
      useClass: PrismaProductionByProcedureRepository,
    },
    {
      provide: UNALLOCATED_PAYMENTS_REPOSITORY,
      useClass: PrismaUnallocatedPaymentsRepository,
    },
    {
      provide: RECOVERED_SLOTS_REPOSITORY,
      useClass: PrismaRecoveredSlotsRepository,
    },
    {
      provide: CHAIR_OCCUPANCY_REPOSITORY,
      useClass: PrismaChairOccupancyRepository,
    },
    {
      provide: PATIENT_LINKS_REPOSITORY,
      useClass: PrismaPatientLinksRepository,
    },
    { provide: PATIENT_LINKS_CLOCK, useValue: () => new Date() },
    {
      provide: PROFITABILITY_REPOSITORY,
      useClass: PrismaProfitabilityRepository,
    },
    {
      provide: QUOTE_FUNNEL_REPOSITORY,
      useClass: PrismaQuoteFunnelRepository,
    },
    {
      provide: CATALOG_CURRENCY_READER,
      useClass: PrismaCatalogCurrencyReader,
    },
  ],
})
export class ReportsModule {}
