import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AppointmentConfirmationsModule } from '../appointment-confirmations/appointment-confirmations.module';
import { LocationsModule } from '../locations/locations.module';
import { LocationScheduleModule } from '../location-schedule/location-schedule.module';
import { ScheduleBlocksModule } from '../schedule-blocks/schedule-blocks.module';
import { ProviderScheduleModule } from '../provider-schedule/provider-schedule.module';
import { StaffModule } from '../staff/staff.module';
import { ChairsModule } from '../chairs/chairs.module';
import { EmailModule } from '../notifications/email/email.module';
import { ONLINE_BOOKING_REPOSITORY } from './domain/ports/online-booking-repository.port';
import {
  BOT_CHALLENGE_VERIFIER,
  NoBotChallengeVerifier,
} from './domain/booking-security';
import { PrismaOnlineBookingRepository } from './infrastructure/prisma-online-booking.repository';
import { OnlineSlotService } from './application/online-slot.service';
import { OnlineChairService } from './application/online-chair.service';
import { OnlineBookingEmail } from './application/online-booking-email';
import {
  CreatePublicBookingUseCase,
  GetPublicBookingConfigUseCase,
  ListPublicSlotsUseCase,
  ONLINE_BOOKING_CLOCK,
  RequestBookingCodeUseCase,
  VerifyBookingCodeUseCase,
} from './application/use-cases/public-booking.use-cases';
import {
  OnlineBookingRequestsUseCases,
  OnlineBookingSettingsUseCases,
  OnlineBookingTypesUseCases,
} from './application/use-cases/online-booking-admin.use-cases';
import { PublicBookingController } from './presentation/public-booking.controller';
import { OnlineBookingController } from './presentation/online-booking.controller';

/**
 * DX-016: reserva online v1 — la página pública /reservar (huecos, código del
 * email, reserva o solicitud) y, para el personal, los ajustes, los tipos
 * reservables y la bandeja «Solicitudes online».
 */
@Module({
  imports: [
    JwtModule.register({}),
    AppointmentsModule,
    AppointmentConfirmationsModule,
    LocationsModule,
    LocationScheduleModule,
    ScheduleBlocksModule,
    ProviderScheduleModule,
    StaffModule,
    ChairsModule,
    EmailModule,
  ],
  controllers: [PublicBookingController, OnlineBookingController],
  providers: [
    TokenService,
    TenantContextInterceptor,
    PublicTenantContextInterceptor,
    {
      provide: ONLINE_BOOKING_REPOSITORY,
      useClass: PrismaOnlineBookingRepository,
    },
    { provide: ONLINE_BOOKING_CLOCK, useValue: () => new Date() },
    // PENDIENTE (decisión del dueño): proveedor de captcha. Hoy no se exige.
    { provide: BOT_CHALLENGE_VERIFIER, useClass: NoBotChallengeVerifier },
    OnlineSlotService,
    OnlineChairService,
    OnlineBookingEmail,
    GetPublicBookingConfigUseCase,
    ListPublicSlotsUseCase,
    RequestBookingCodeUseCase,
    VerifyBookingCodeUseCase,
    CreatePublicBookingUseCase,
    OnlineBookingSettingsUseCases,
    OnlineBookingTypesUseCases,
    OnlineBookingRequestsUseCases,
  ],
})
export class OnlineBookingModule {}
