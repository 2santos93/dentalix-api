import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { LocationsModule } from '../locations/locations.module';
import { StaffModule } from '../staff/staff.module';
import {
  ProviderScheduleController,
  ScheduleRosterController,
} from './presentation/provider-schedule.controller';
import {
  DeleteProviderOverrideUseCase,
  GetProviderScheduleSettingsUseCase,
  GetProviderScheduleUseCase,
  GetScheduleRosterUseCase,
  ListProviderOverridesUseCase,
  PROVIDER_SCHEDULE_CLOCK,
  ReplaceProviderScheduleUseCase,
  SetProviderOverrideUseCase,
  UpdateProviderScheduleSettingsUseCase,
} from './application/use-cases/provider-schedule.use-cases';
import { ProviderAvailabilityService } from './application/provider-availability.service';
import { PROVIDER_SCHEDULE_REPOSITORY } from './domain/ports/provider-schedule-repository.port';
import { PrismaProviderScheduleRepository } from './infrastructure/prisma-provider-schedule.repository';

/**
 * Horario de cada profesional por sede con excepciones por fecha (DX-233).
 * Exporta `ProviderAvailabilityService` para que la agenda avise (o rechace en
 * modo estricto) al agendar fuera de horario, y para que «Buscar hueco» y
 * «Ocupar este hueco» solo propongan donde el profesional trabaja.
 */
@Module({
  imports: [JwtModule.register({}), LocationsModule, StaffModule],
  controllers: [ProviderScheduleController, ScheduleRosterController],
  providers: [
    GetProviderScheduleUseCase,
    ReplaceProviderScheduleUseCase,
    ListProviderOverridesUseCase,
    SetProviderOverrideUseCase,
    DeleteProviderOverrideUseCase,
    GetScheduleRosterUseCase,
    GetProviderScheduleSettingsUseCase,
    UpdateProviderScheduleSettingsUseCase,
    ProviderAvailabilityService,
    TokenService,
    TenantContextInterceptor,
    {
      provide: PROVIDER_SCHEDULE_REPOSITORY,
      useClass: PrismaProviderScheduleRepository,
    },
    { provide: PROVIDER_SCHEDULE_CLOCK, useValue: () => new Date() },
  ],
  exports: [ProviderAvailabilityService],
})
export class ProviderScheduleModule {}
