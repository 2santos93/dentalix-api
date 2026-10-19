import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppointmentsController } from './presentation/appointments.controller';
import { CreateAppointmentUseCase } from './application/use-cases/create-appointment.use-case';
import { ListAppointmentsUseCase } from './application/use-cases/list-appointments.use-case';
import { ListUpcomingAppointmentsUseCase } from './application/use-cases/list-upcoming-appointments.use-case';
import { GetAppointmentUseCase } from './application/use-cases/get-appointment.use-case';
import { UpdateAppointmentUseCase } from './application/use-cases/update-appointment.use-case';
import { APPOINTMENT_REPOSITORY } from './domain/ports/appointment-repository.port';
import { PrismaAppointmentRepository } from './infrastructure/repositories/prisma-appointment.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { PatientsModule } from '../patients/patients.module';
import { StaffModule } from '../staff/staff.module';
import { LocationScheduleModule } from '../location-schedule/location-schedule.module';
import { AppointmentTypesModule } from '../appointment-types/appointment-types.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { ScheduleBlocksModule } from '../schedule-blocks/schedule-blocks.module';
import { LocationsModule } from '../locations/locations.module';
import { CollectionsModule } from '../collections/collections.module';
import { FindOpeningsUseCase } from './application/use-cases/find-openings.use-case';
import { ListInClinicUseCase } from './application/use-cases/list-in-clinic.use-case';

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
    // DX-121: valida el tipo de cita y toma su duración al agendar.
    AppointmentTypesModule,
    // DX-122: bloqueos al agendar/mover y «Buscar hueco» (sede y su zona).
    ScheduleBlocksModule,
    LocationsModule,
    // DX-150: marca «Saldo vencido» de las tarjetas, por lote.
    CollectionsModule,
  ],
  controllers: [AppointmentsController],
  providers: [
    CreateAppointmentUseCase,
    ListAppointmentsUseCase,
    ListUpcomingAppointmentsUseCase,
    GetAppointmentUseCase,
    UpdateAppointmentUseCase,
    FindOpeningsUseCase,
    // DX-200: panel «En clínica».
    ListInClinicUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on AppointmentsController.
    TenantContextInterceptor,
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
  ],
  // ListUpcomingAppointmentsUseCase exportado para las «próximas citas» del
  // dashboard: la BD devuelve ya cortado en `limit` (DX-043, DB-008).
  // DX-122: «Agendar aquí» desde pendientes reutiliza CreateAppointmentUseCase.
  exports: [ListUpcomingAppointmentsUseCase, CreateAppointmentUseCase],
})
export class AppointmentsModule {}
