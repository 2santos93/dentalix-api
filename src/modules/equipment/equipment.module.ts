import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { ChairsModule } from '../chairs/chairs.module';
import { LocationsModule } from '../locations/locations.module';
import { CURRENCY_WHITELIST } from '../treatment-plans/domain/ports/currency-whitelist.port';
import { PrismaCurrencyWhitelist } from '../treatment-plans/infrastructure/adapters/prisma-currency-whitelist.adapter';
import {
  CreateEquipmentUseCase,
  GetEquipmentUseCase,
  ListEquipmentUseCase,
  RecordMaintenanceUseCase,
  RetireEquipmentUseCase,
  UpdateEquipmentUseCase,
  VoidMaintenanceUseCase,
} from './application/use-cases/equipment.use-cases';
import {
  EQUIPMENT_CLOCK,
  EQUIPMENT_REPOSITORY,
} from './domain/ports/equipment-repository.port';
import { PrismaEquipmentRepository } from './infrastructure/repositories/prisma-equipment.repository';
import { EquipmentController } from './presentation/equipment.controller';

/**
 * Equipos biomédicos por sede con hoja de vida y mantenimientos (DX-542).
 * Usa el repositorio de sillones (DX-211) para «¿este sillón es de la sede
 * del equipo?» y el de sedes para su zona («hoy» de la sede).
 */
@Module({
  imports: [JwtModule.register({}), LocationsModule, ChairsModule],
  controllers: [EquipmentController],
  providers: [
    ListEquipmentUseCase,
    GetEquipmentUseCase,
    CreateEquipmentUseCase,
    UpdateEquipmentUseCase,
    RetireEquipmentUseCase,
    RecordMaintenanceUseCase,
    VoidMaintenanceUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: EQUIPMENT_REPOSITORY, useClass: PrismaEquipmentRepository },
    { provide: EQUIPMENT_CLOCK, useValue: () => new Date() },
    { provide: CURRENCY_WHITELIST, useClass: PrismaCurrencyWhitelist },
  ],
})
export class EquipmentModule {}
