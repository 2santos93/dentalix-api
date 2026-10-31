import { Module } from '@nestjs/common';
import { ProviderScheduleModule } from '../provider-schedule/provider-schedule.module';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AppointmentTypesModule } from '../appointment-types/appointment-types.module';
import { LocationsModule } from '../locations/locations.module';
import { PatientsModule } from '../patients/patients.module';
import { StaffModule } from '../staff/staff.module';
import { WaitlistController } from './presentation/waitlist.controller';
import { PublicSlotOffersController } from './presentation/public-slot-offers.controller';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { EmailModule } from '../notifications/email/email.module';
import { LocationScheduleModule } from '../location-schedule/location-schedule.module';
import { ScheduleBlocksModule } from '../schedule-blocks/schedule-blocks.module';
import { CreateLinkOfferUseCase } from './application/use-cases/link-offers.use-cases';
import {
  AcceptSlotOfferUseCase,
  DeclineSlotOfferUseCase,
  GetPublicSlotOfferUseCase,
} from './application/use-cases/public-slot-offers.use-cases';
import {
  OutboxSlotOfferEmailSender,
  SLOT_OFFER_EMAIL_SENDER,
} from './application/slot-offer-email';
import { SLOT_OFFER_REPOSITORY } from './domain/ports/slot-offer-repository.port';
import { PrismaSlotOfferRepository } from './infrastructure/repositories/prisma-slot-offer.repository';
import {
  LINK_OFFER_CONFIG,
  loadLinkOfferConfig,
} from './domain/slot-offer-link';
import { OpeningCandidatesController } from './presentation/opening-candidates.controller';
import {
  CreateWaitlistOfferUseCase,
  ListOpeningCandidatesUseCase,
  OPENING_CLOCK,
  RecordWaitlistOfferOutcomeUseCase,
} from './application/use-cases/opening-candidates.use-cases';
import { OPENING_CANDIDATES_REPOSITORY } from './domain/ports/opening-candidates-repository.port';
import { PrismaOpeningCandidatesRepository } from './infrastructure/repositories/prisma-opening-candidates.repository';
import {
  WAITLIST_OFFER_CONFIG,
  loadWaitlistOfferConfig,
} from './domain/waitlist-offer-rules';
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
 * DX-210: también «Ocupar este hueco» (candidatos de un hueco libre y las
 * ofertas que se les hacen).
 */
@Module({
  imports: [
    JwtModule.register({}),
    AppointmentsModule,
    AppointmentTypesModule,
    LocationsModule,
    PatientsModule,
    StaffModule,
    // DX-233: horario de cada profesional por sede.
    ProviderScheduleModule,
    // DX-435: email de la oferta con enlace (outbox, DX-088) y reglas de
    // agenda al aceptar desde el enlace (horario de la sede y bloqueos).
    EmailModule,
    LocationScheduleModule,
    ScheduleBlocksModule,
  ],
  controllers: [
    WaitlistController,
    OpeningCandidatesController,
    PublicSlotOffersController,
  ],
  providers: [
    ListWaitlistUseCase,
    CreateWaitlistEntryUseCase,
    DismissWaitlistEntryUseCase,
    ScheduleFromWaitlistUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: WAITLIST_REPOSITORY, useClass: PrismaWaitlistRepository },
    // DX-210: «Ocupar este hueco» (candidatos y ofertas).
    ListOpeningCandidatesUseCase,
    CreateWaitlistOfferUseCase,
    RecordWaitlistOfferOutcomeUseCase,
    {
      provide: OPENING_CANDIDATES_REPOSITORY,
      useClass: PrismaOpeningCandidatesRepository,
    },
    // Tope de ofertas por paciente y día (WAITLIST_OFFERS_PER_PATIENT_PER_DAY,
    // 2 por defecto). Un valor inválido hace fallar el arranque.
    {
      provide: WAITLIST_OFFER_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loadWaitlistOfferConfig((key) => config.get<string>(key)),
    },
    { provide: OPENING_CLOCK, useValue: () => new Date() },
    // DX-435: oferta de hueco por enlace (el primero que acepta se lo queda).
    PublicTenantContextInterceptor,
    CreateLinkOfferUseCase,
    GetPublicSlotOfferUseCase,
    AcceptSlotOfferUseCase,
    DeclineSlotOfferUseCase,
    { provide: SLOT_OFFER_REPOSITORY, useClass: PrismaSlotOfferRepository },
    { provide: SLOT_OFFER_EMAIL_SENDER, useClass: OutboxSlotOfferEmailSender },
    // Minutos antes del hueco en que caduca el enlace
    // (WAITLIST_LINK_OFFER_EXPIRY_LEAD_MINUTES, 0 = al empezar).
    {
      provide: LINK_OFFER_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loadLinkOfferConfig((key) => config.get<string>(key)),
    },
  ],
})
export class WaitlistModule {}
