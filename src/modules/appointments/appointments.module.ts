import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppointmentsController } from './presentation/appointments.controller';
import { CreateAppointmentUseCase } from './application/use-cases/create-appointment.use-case';
import { ListAppointmentsUseCase } from './application/use-cases/list-appointments.use-case';
import { GetAppointmentUseCase } from './application/use-cases/get-appointment.use-case';
import { UpdateAppointmentUseCase } from './application/use-cases/update-appointment.use-case';
import { APPOINTMENT_REPOSITORY } from './domain/ports/appointment-repository.port';
import { PrismaAppointmentRepository } from './infrastructure/repositories/prisma-appointment.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { PatientsModule } from '../patients/patients.module';
import { StaffModule } from '../staff/staff.module';
import { LocationScheduleModule } from '../location-schedule/location-schedule.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors PatientsModule/OdontogramModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  // PatientsModule/StaffModule se importan (no se re-implementan) para que
  // CreateAppointmentUseCase valide que paciente y profesional pertenezcan a la
  // clínica; ambos exportan su repositorio para exactamente este caso.
  imports: [
    JwtModule.register({}),
    PatientsModule,
    StaffModule,
    LocationScheduleModule,
  ],
  controllers: [AppointmentsController],
  providers: [
    CreateAppointmentUseCase,
    ListAppointmentsUseCase,
    GetAppointmentUseCase,
    UpdateAppointmentUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on AppointmentsController.
    TenantContextInterceptor,
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
  ],
  // Exported (additive) so DashboardModule can inject ListAppointmentsUseCase
  // by class for the upcoming-appointments aggregation.
  exports: [ListAppointmentsUseCase],
})
export class AppointmentsModule {}
