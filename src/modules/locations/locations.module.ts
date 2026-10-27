import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LocationsController } from './presentation/locations.controller';
import {
  CreateLocationUseCase,
  ListLocationsUseCase,
  UpdateLocationUseCase,
} from './application/use-cases/manage-locations.use-cases';
import { LOCATION_REPOSITORY } from './domain/ports/location-repository.port';
import { PrismaLocationRepository } from './infrastructure/repositories/prisma-location.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CURRENCY_WHITELIST } from '../treatment-plans/domain/ports/currency-whitelist.port';
import { PrismaCurrencyWhitelist } from '../treatment-plans/infrastructure/adapters/prisma-currency-whitelist.adapter';
import { JobsModule } from '../jobs/jobs.module';
import { LocationRegionalBackfillJob } from './infrastructure/jobs/location-regional-backfill.job';

@Module({
  // JobsModule: barrido de sedes sin configurar de fase 1 (GLOBAL-G1 §2.3).
  imports: [JwtModule.register({}), JobsModule],
  controllers: [LocationsController],
  providers: [
    ListLocationsUseCase,
    CreateLocationUseCase,
    UpdateLocationUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: LOCATION_REPOSITORY, useClass: PrismaLocationRepository },
    // G1: la moneda de la sede tiene que estar en `currencies` (spec §3.1).
    { provide: CURRENCY_WHITELIST, useClass: PrismaCurrencyWhitelist },
    LocationRegionalBackfillJob,
  ],
  // DX-122: bloqueos, pendientes y «Buscar hueco» validan que la sede del
  // cliente es de esta clínica (y leen su zona horaria).
  exports: [LOCATION_REPOSITORY],
})
export class LocationsModule {}
