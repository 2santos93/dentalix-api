import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { EquipmentModule } from '../equipment/equipment.module';
import { LocationsModule } from '../locations/locations.module';
import { StaffModule } from '../staff/staff.module';
import {
  CreateRadiologyRecordUseCase,
  GetRadiologyRecordUseCase,
  ListRadiologyDueUseCase,
  ListRadiologyRecordsUseCase,
  UpdateRadiologyRecordUseCase,
  VoidRadiologyRecordUseCase,
} from './application/use-cases/radiology.use-cases';
import {
  RADIOLOGY_CLOCK,
  RADIOLOGY_REPOSITORY,
} from './domain/ports/radiology-repository.port';
import { PrismaRadiologyRepository } from './infrastructure/repositories/prisma-radiology.repository';
import { RadiologyController } from './presentation/radiology.controller';

/**
 * Expediente de rayos X por sede (DX-544): licencias y controles de calidad
 * con vencimiento. Usa el repositorio de equipos (DX-542) para «¿este equipo
 * es de rayos X de la sede?», el de sedes para su zona y el del personal para
 * el encargado de protección radiológica.
 */
@Module({
  imports: [
    JwtModule.register({}),
    LocationsModule,
    EquipmentModule,
    StaffModule,
  ],
  controllers: [RadiologyController],
  providers: [
    ListRadiologyRecordsUseCase,
    GetRadiologyRecordUseCase,
    CreateRadiologyRecordUseCase,
    UpdateRadiologyRecordUseCase,
    VoidRadiologyRecordUseCase,
    ListRadiologyDueUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: RADIOLOGY_REPOSITORY, useClass: PrismaRadiologyRepository },
    { provide: RADIOLOGY_CLOCK, useValue: () => new Date() },
  ],
})
export class RadiologyModule {}
