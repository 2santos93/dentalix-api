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

@Module({
  imports: [JwtModule.register({})],
  controllers: [LocationsController],
  providers: [
    ListLocationsUseCase,
    CreateLocationUseCase,
    UpdateLocationUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: LOCATION_REPOSITORY, useClass: PrismaLocationRepository },
  ],
})
export class LocationsModule {}
