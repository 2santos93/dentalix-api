import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LocationScheduleController } from './presentation/location-schedule.controller';
import {
  GetLocationScheduleUseCase,
  ReplaceLocationScheduleUseCase,
} from './application/use-cases/manage-location-schedule.use-cases';
import { LOCATION_SCHEDULE_REPOSITORY } from './domain/ports/location-schedule-repository.port';
import { PrismaLocationScheduleRepository } from './infrastructure/repositories/prisma-location-schedule.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  imports: [JwtModule.register({})],
  controllers: [LocationScheduleController],
  providers: [
    GetLocationScheduleUseCase,
    ReplaceLocationScheduleUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: LOCATION_SCHEDULE_REPOSITORY,
      useClass: PrismaLocationScheduleRepository,
    },
  ],
  // Exportado (aditivo) para que Create/UpdateAppointmentUseCase validen el
  // horario de atención — mismo patrón cross-module que Patients/Staff
  // exportando su repo para la validación de pertenencia.
  exports: [LOCATION_SCHEDULE_REPOSITORY],
})
export class LocationScheduleModule {}
