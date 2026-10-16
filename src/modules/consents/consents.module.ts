import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';
import { ConsentTemplatesController } from './presentation/consent-templates.controller';
import { PatientConsentsController } from './presentation/patient-consents.controller';
import {
  CreateConsentTemplateUseCase,
  ListConsentTemplatesUseCase,
  UpdateConsentTemplateUseCase,
} from './application/use-cases/consent-templates.use-cases';
import {
  CONSENT_CLOCK,
  GetPatientConsentUseCase,
  ListPatientConsentsUseCase,
  PreviewPatientConsentUseCase,
  SignPatientConsentUseCase,
} from './application/use-cases/patient-consents.use-cases';
import { CONSENT_TEMPLATE_REPOSITORY } from './domain/ports/consent-template-repository.port';
import { PATIENT_CONSENT_REPOSITORY } from './domain/ports/patient-consent-repository.port';
import { PrismaConsentTemplateRepository } from './infrastructure/repositories/prisma-consent-template.repository';
import { PrismaPatientConsentRepository } from './infrastructure/repositories/prisma-patient-consent.repository';

/**
 * Consentimientos informados (DX-006): plantillas por clínica y consentimientos
 * firmados en pantalla, append-only. PatientsModule exporta PATIENT_REPOSITORY
 * para el 404 de "paciente de otra clínica" del listado.
 */
@Module({
  imports: [JwtModule.register({}), PatientsModule],
  controllers: [ConsentTemplatesController, PatientConsentsController],
  providers: [
    ListConsentTemplatesUseCase,
    CreateConsentTemplateUseCase,
    UpdateConsentTemplateUseCase,
    ListPatientConsentsUseCase,
    PreviewPatientConsentUseCase,
    SignPatientConsentUseCase,
    GetPatientConsentUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: CONSENT_CLOCK, useValue: () => new Date() },
    {
      provide: CONSENT_TEMPLATE_REPOSITORY,
      useClass: PrismaConsentTemplateRepository,
    },
    {
      provide: PATIENT_CONSENT_REPOSITORY,
      useClass: PrismaPatientConsentRepository,
    },
  ],
})
export class ConsentsModule {}
