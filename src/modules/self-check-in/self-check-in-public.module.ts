import { Module } from '@nestjs/common';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AppointmentConfirmationsModule } from '../appointment-confirmations/appointment-confirmations.module';
import {
  CHECK_IN_CLOCK,
  CHECK_IN_SLEEPER,
  PublicCheckInUseCases,
  realCheckInSleeper,
} from './application/public-check-in.use-cases';
import {
  PublicAppointmentArrivalController,
  PublicCheckInController,
} from './presentation/public-check-in.controller';
import { SelfCheckInModule } from './self-check-in.module';

/**
 * DX-265: las rutas públicas de «Ya llegué»: el enlace de la cita (DX-005) y
 * el QR de la sede. La llegada pasa por `UpdateAppointmentUseCase` (el MISMO
 * camino que recepción).
 */
@Module({
  imports: [
    AppointmentsModule,
    AppointmentConfirmationsModule,
    SelfCheckInModule,
  ],
  controllers: [PublicAppointmentArrivalController, PublicCheckInController],
  providers: [
    PublicCheckInUseCases,
    PublicTenantContextInterceptor,
    { provide: CHECK_IN_CLOCK, useValue: () => new Date() },
    { provide: CHECK_IN_SLEEPER, useValue: realCheckInSleeper },
  ],
})
export class SelfCheckInPublicModule {}
