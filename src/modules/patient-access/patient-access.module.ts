import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AccountStatementModule } from '../account-statement/account-statement.module';
import { AppointmentConfirmationsModule } from '../appointment-confirmations/appointment-confirmations.module';
import { TreatmentPlansModule } from '../treatment-plans/treatment-plans.module';
import {
  PATIENT_ACCESS_CLOCK,
  PATIENT_ACCESS_SESSION_KEY,
  PATIENT_ACCESS_SLEEPER,
} from './application/patient-access-clock';
import { UnknownTokenAttempts } from './application/unknown-token-attempts';
import {
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
 * cuenta, confirmar una cita). Reutiliza las consultas de DX-011 (estado de
 * cuenta), DX-012 (presupuesto) y el flujo de confirmación de DX-005.
 */
@Module({
  imports: [
    JwtModule.register({}),
    AccountStatementModule,
    TreatmentPlansModule,
    AppointmentConfirmationsModule,
  ],
  controllers: [PatientAccessLinksController, PublicPatientAccessController],
  providers: [
    CreateAccessLinkUseCase,
    ListAccessLinksUseCase,
    RevokeAccessLinkUseCase,
    VerifyPatientAccessUseCase,
    GetPatientPortalUseCase,
    ConfirmPortalAppointmentUseCase,
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
