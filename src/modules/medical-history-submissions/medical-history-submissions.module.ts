import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { MEDICAL_HISTORY_REPOSITORY } from '../medical-history/domain/ports/medical-history-repository.port';
import { PrismaMedicalHistoryRepository } from '../medical-history/infrastructure/repositories/prisma-medical-history.repository';
import { ANAMNESIS_CLOCK } from './application/anamnesis-clock';
import {
  CreateAnamnesisRequestUseCase,
  ListPatientAnamnesisRequestsUseCase,
  RevokeAnamnesisRequestUseCase,
} from './application/use-cases/anamnesis-requests.use-cases';
import {
  AcceptAnamnesisUseCase,
  CountAnamnesisInboxUseCase,
  GetAnamnesisReviewUseCase,
  ListAnamnesisInboxUseCase,
  RejectAnamnesisUseCase,
} from './application/use-cases/anamnesis-review.use-cases';
import {
  GetPublicAnamnesisUseCase,
  SubmitPublicAnamnesisUseCase,
} from './application/use-cases/public-anamnesis.use-cases';
import { MEDICAL_HISTORY_SUBMISSION_REPOSITORY } from './domain/ports/medical-history-submission-repository.port';
import { PrismaMedicalHistorySubmissionRepository } from './infrastructure/prisma-medical-history-submission.repository';
import { MedicalHistorySubmissionsController } from './presentation/medical-history-submissions.controller';
import { PatientAnamnesisRequestsController } from './presentation/patient-anamnesis-requests.controller';
import { PublicMedicalHistoryController } from './presentation/public-medical-history.controller';

/**
 * DX-099: anamnesis previa a la cita por enlace seguro. Rutas del personal
 * (crear el enlace, bandeja, revisión, aceptar, rechazar, anular) y rutas
 * públicas del paciente (ver el cuestionario y enviarlo). Mismo cableado que
 * AppointmentConfirmationsModule (JwtModule para JwtAuthGuard y los dos
 * interceptores de tenant como providers).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [
    PatientAnamnesisRequestsController,
    MedicalHistorySubmissionsController,
    PublicMedicalHistoryController,
  ],
  providers: [
    CreateAnamnesisRequestUseCase,
    ListPatientAnamnesisRequestsUseCase,
    RevokeAnamnesisRequestUseCase,
    ListAnamnesisInboxUseCase,
    CountAnamnesisInboxUseCase,
    GetAnamnesisReviewUseCase,
    AcceptAnamnesisUseCase,
    RejectAnamnesisUseCase,
    GetPublicAnamnesisUseCase,
    SubmitPublicAnamnesisUseCase,
    { provide: ANAMNESIS_CLOCK, useValue: () => new Date() },
    {
      provide: MEDICAL_HISTORY_SUBMISSION_REPOSITORY,
      useClass: PrismaMedicalHistorySubmissionRepository,
    },
    {
      provide: MEDICAL_HISTORY_REPOSITORY,
      useClass: PrismaMedicalHistoryRepository,
    },
    TokenService,
    TenantContextInterceptor,
    PublicTenantContextInterceptor,
  ],
})
export class MedicalHistorySubmissionsModule {}
