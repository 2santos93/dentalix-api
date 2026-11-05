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

// Reportes de gestión (DX-014). Pestañas: «Comparar sedes» (indicadores en
// `domain/kpi-definitions.ts`), «Producción por procedimiento» (DX-423) y
// «Cobrado sin imputar» (DX-399, ADMIN y recepción); las
// siguientes se añaden como controladores bajo el mismo prefijo `reports`.
@Module({
  imports: [JwtModule.register({})],
  controllers: [
    LocationsComparisonController,
    ProductionByProcedureController,
    UnallocatedPaymentsController,
  ],
  providers: [
    GetLocationsComparisonUseCase,
    GetProductionByProcedureUseCase,
    GetUnallocatedPaymentsUseCase,
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
  ],
})
export class ReportsModule {}
