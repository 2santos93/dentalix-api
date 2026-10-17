import { Module } from '@nestjs/common';
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
  ],
  controllers: [WaitlistController, OpeningCandidatesController],
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
  ],
})
export class WaitlistModule {}
