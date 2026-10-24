import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { GetLocationsComparisonUseCase } from './application/use-cases/get-locations-comparison.use-case';
import { LOCATIONS_COMPARISON_REPOSITORY } from './domain/ports/locations-comparison-repository.port';
import { PrismaLocationsComparisonRepository } from './infrastructure/prisma-locations-comparison.repository';
import { LocationsComparisonController } from './presentation/locations-comparison.controller';

// Reportes de gestión (DX-014). Primera pestaña: «Comparar sedes». Los
// indicadores se definen en `domain/kpi-definitions.ts`; las siguientes
// pestañas (cartera, no-show, productividad) se añaden como controladores
// bajo el mismo prefijo `reports`.
@Module({
  imports: [JwtModule.register({})],
  controllers: [LocationsComparisonController],
  providers: [
    GetLocationsComparisonUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: LOCATIONS_COMPARISON_REPOSITORY,
      useClass: PrismaLocationsComparisonRepository,
    },
  ],
})
export class ReportsModule {}
