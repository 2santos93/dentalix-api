import { Module } from '@nestjs/common';
import { ProviderScheduleModule } from '../provider-schedule/provider-schedule.module';
import { JwtModule } from '@nestjs/jwt';
import { AppointmentsController } from './presentation/appointments.controller';
import { CreateAppointmentUseCase } from './application/use-cases/create-appointment.use-case';
import { ListAppointmentsUseCase } from './application/use-cases/list-appointments.use-case';
import { ListUpcomingAppointmentsUseCase } from './application/use-cases/list-upcoming-appointments.use-case';
import { GetAppointmentUseCase } from './application/use-cases/get-appointment.use-case';
import { UpdateAppointmentUseCase } from './application/use-cases/update-appointment.use-case';
import { APPOINTMENT_REPOSITORY } from './domain/ports/appointment-repository.port';
import { PrismaAppointmentRepository } from './infrastructure/repositories/prisma-appointment.repository';
import { RESERVED_OVERRIDE_REPOSITORY } from './domain/ports/reserved-override-repository.port';
import { PrismaReservedOverrideRepository } from './infrastructure/repositories/prisma-reserved-override.repository';
import { WALK_IN_REPOSITORY } from './domain/ports/walk-in-repository.port';
import { PrismaWalkInRepository } from './infrastructure/repositories/prisma-walk-in.repository';
import { CreateWalkInUseCase } from './application/use-cases/create-walk-in.use-case';
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
import { PatientAttendanceController } from './presentation/patient-attendance.controller';
import {
  GetPatientAttendanceUseCase,
  PatientAttendanceFlags,
} from './application/attendance/patient-attendance';
import { PATIENT_ATTENDANCE_REPOSITORY } from './domain/ports/patient-attendance-repository.port';
import { PrismaPatientAttendanceRepository } from './infrastructure/repositories/prisma-patient-attendance.repository';

import { PatientCoveragesModule } from '../patient-coverages/patient-coverages.module';
import { MedicalHistoryModule } from '../medical-history/medical-history.module';
import { ChairsModule } from '../chairs/chairs.module';
import { ChairAssignmentService } from './application/chair-assignment';

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
    // DX-153: resumen `coverage` de las tarjetas, por lote.
    PatientCoveragesModule,
    // DX-233: horario de cada profesional por sede.
    ProviderScheduleModule,
    // DX-247: banderas médicas mínimas de las tarjetas y de «En clínica».
    MedicalHistoryModule,
    // DX-211: sillón de la cita (de la sede, activo y libre).
    ChairsModule,
  ],
  controllers: [AppointmentsController, PatientAttendanceController],
  providers: [
    CreateAppointmentUseCase,
    ListAppointmentsUseCase,
    ListUpcomingAppointmentsUseCase,
    GetAppointmentUseCase,
    UpdateAppointmentUseCase,
    FindOpeningsUseCase,
    // DX-200: panel «En clínica».
    ListInClinicUseCase,
    // DX-211: sillón de la cita al agendar o mover.
    ChairAssignmentService,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on AppointmentsController.
    TenantContextInterceptor,
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
    // DX-446: motivo de «Agendar igualmente» en un hueco reservado.
    {
      provide: RESERVED_OVERRIDE_REPOSITORY,
      useClass: PrismaReservedOverrideRepository,
    },
    // DX-470: «Atender sin cita» (paciente, cita ARRIVED y triaje en un paso).
    CreateWalkInUseCase,
    { provide: WALK_IN_REPOSITORY, useClass: PrismaWalkInRepository },
    // DX-279: asistencia del paciente (resumen de 12 meses e insignia).
    PatientAttendanceFlags,
    GetPatientAttendanceUseCase,
    {
      provide: PATIENT_ATTENDANCE_REPOSITORY,
      useClass: PrismaPatientAttendanceRepository,
    },
  ],
  // ListUpcomingAppointmentsUseCase exportado para las «próximas citas» del
  // dashboard: la BD devuelve ya cortado en `limit` (DX-043, DB-008).
  // DX-122: «Agendar aquí» desde pendientes reutiliza CreateAppointmentUseCase.
  exports: [ListUpcomingAppointmentsUseCase, CreateAppointmentUseCase],
})
export class AppointmentsModule {}
