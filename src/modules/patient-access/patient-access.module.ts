import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AccountStatementModule } from '../account-statement/account-statement.module';
import { AppointmentConfirmationsModule } from '../appointment-confirmations/appointment-confirmations.module';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { EmailModule } from '../notifications/email/email.module';
import { PLAN_QUOTE_COMPOSITION } from '../treatment-plans/application/use-cases/plan-quote.use-cases';
import { loadPlanQuoteComposition } from '../treatment-plans/application/plan-quote-composition.config';
import { TreatmentPlansModule } from '../treatment-plans/treatment-plans.module';
import {
  PATIENT_ACCESS_CLOCK,
  PATIENT_ACCESS_SESSION_KEY,
  PATIENT_ACCESS_SLEEPER,
} from './application/patient-access-clock';
import { UnknownTokenAttempts } from './application/unknown-token-attempts';
import {
  OutboxPortalAcceptanceEmail,
  PORTAL_ACCEPTANCE_EMAIL,
} from './application/portal-acceptance-email';
import {
  AcceptPortalQuoteUseCase,
  ConfirmPortalAppointmentUseCase,
  GetPatientPortalUseCase,
  VerifyPatientAccessUseCase,
} from './application/use-cases/public-patient-access.use-cases';
import {
  CreateAccessLinkUseCase,
  ListAccessLinksUseCase,
  RevokeAccessLinkUseCase,
} from './application/use-cases/staff-access-links.use-cases';
import { derivePatientAccessSessionKey } from './domain/patient-access-session';
import { PATIENT_ACCESS_REPOSITORY } from './domain/ports/patient-access-repository.port';
import { PrismaPatientAccessRepository } from './infrastructure/prisma-patient-access.repository';
import { PatientAccessLinksController } from './presentation/patient-access-links.controller';
import { PatientAccessHeadersInterceptor } from './presentation/patient-access-headers.interceptor';
import { PatientAccessSessionGuard } from './presentation/patient-access-session.guard';
import { PublicPatientAccessController } from './presentation/public-patient-access.controller';

/**
 * DX-101: estado de cuenta del paciente por enlace seguro. Enlaces de acceso
 * de la ficha (crear, listar, revocar) y el portal público de solo lectura
 * (verificar la fecha de nacimiento, ver citas, presupuestos y estado de
 * cuenta, confirmar una cita y, DX-101-bis, aceptar un presupuesto con
 * firma). Reutiliza las consultas de DX-011 (estado de
 * cuenta), DX-012 (presupuesto) y el flujo de confirmación de DX-005.
 */
@Module({
  imports: [
    JwtModule.register({}),
    AccountStatementModule,
    TreatmentPlansModule,
    AppointmentConfirmationsModule,
    // DX-101-bis: aceptar el presupuesto (nombres de documento de la
    // clínica y email de confirmación).
    DocumentTypeNamesModule,
    EmailModule,
  ],
  controllers: [PatientAccessLinksController, PublicPatientAccessController],
  providers: [
    CreateAccessLinkUseCase,
    ListAccessLinksUseCase,
    RevokeAccessLinkUseCase,
    VerifyPatientAccessUseCase,
    GetPatientPortalUseCase,
    ConfirmPortalAppointmentUseCase,
    AcceptPortalQuoteUseCase,
    { provide: PORTAL_ACCEPTANCE_EMAIL, useClass: OutboxPortalAcceptanceEmail },
    // DX-502: la misma composición que GetPlanQuoteUseCase (el hash que
    // muestra el portal es el que se compara al aceptar).
    {
      provide: PLAN_QUOTE_COMPOSITION,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loadPlanQuoteComposition((key) => config.get<string>(key)),
    },
    UnknownTokenAttempts,
    PatientAccessSessionGuard,
    PatientAccessHeadersInterceptor,
    TokenService,
    TenantContextInterceptor,
    {
      provide: PATIENT_ACCESS_REPOSITORY,
      useClass: PrismaPatientAccessRepository,
    },
    { provide: PATIENT_ACCESS_CLOCK, useValue: () => new Date() },
    {
      provide: PATIENT_ACCESS_SLEEPER,
      useValue: (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
    {
      provide: PATIENT_ACCESS_SESSION_KEY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Buffer =>
        derivePatientAccessSessionKey(
          config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        ),
    },
  ],
})
export class PatientAccessModule {}
