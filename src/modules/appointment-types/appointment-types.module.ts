import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AppointmentTypesController } from './presentation/appointment-types.controller';
import {
  CreateAppointmentTypeUseCase,
  DeleteAppointmentTypeUseCase,
  ListAppointmentTypesUseCase,
  UpdateAppointmentTypeUseCase,
} from './application/use-cases/appointment-types.use-cases';
import { APPOINTMENT_TYPE_REPOSITORY } from './domain/ports/appointment-type-repository.port';
import { PrismaAppointmentTypeRepository } from './infrastructure/repositories/prisma-appointment-type.repository';

/**
 * Tipos de cita (DX-121). Exporta el repositorio para que AppointmentsModule
 * resuelva "¿este tipo es de ESTA clínica y está activo?" y su duración al
 * agendar, sin re-implementarlo.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AppointmentTypesController],
  providers: [
    ListAppointmentTypesUseCase,
    CreateAppointmentTypeUseCase,
    UpdateAppointmentTypeUseCase,
    DeleteAppointmentTypeUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: APPOINTMENT_TYPE_REPOSITORY,
      useClass: PrismaAppointmentTypeRepository,
    },
  ],
  exports: [APPOINTMENT_TYPE_REPOSITORY],
})
export class AppointmentTypesModule {}
