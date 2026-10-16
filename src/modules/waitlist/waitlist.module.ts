import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AppointmentTypesModule } from '../appointment-types/appointment-types.module';
import { LocationsModule } from '../locations/locations.module';
import { PatientsModule } from '../patients/patients.module';
import { StaffModule } from '../staff/staff.module';
import { WaitlistController } from './presentation/waitlist.controller';
import {
  CreateWaitlistEntryUseCase,
  DismissWaitlistEntryUseCase,
  ListWaitlistUseCase,
  ScheduleFromWaitlistUseCase,
} from './application/use-cases/waitlist.use-cases';
import { WAITLIST_REPOSITORY } from './domain/ports/waitlist-repository.port';
import { PrismaWaitlistRepository } from './infrastructure/repositories/prisma-waitlist.repository';

/**
 * «Pendientes por agendar» (DX-122). Agendar desde una entrada reutiliza
 * CreateAppointmentUseCase (todas las reglas de una cita nueva); el alta
 * automática al cancelar vive en la transacción de la cita
 * (`waitlist-transitions.ts`), así que AppointmentsModule no depende de este.
 */
@Module({
  imports: [
    JwtModule.register({}),
    AppointmentsModule,
    AppointmentTypesModule,
    LocationsModule,
    PatientsModule,
    StaffModule,
  ],
  controllers: [WaitlistController],
  providers: [
    ListWaitlistUseCase,
    CreateWaitlistEntryUseCase,
    DismissWaitlistEntryUseCase,
    ScheduleFromWaitlistUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: WAITLIST_REPOSITORY, useClass: PrismaWaitlistRepository },
  ],
})
export class WaitlistModule {}
