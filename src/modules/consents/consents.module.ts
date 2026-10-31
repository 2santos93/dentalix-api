import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { ConsentTemplatesController } from './presentation/consent-templates.controller';
import { PatientConsentsController } from './presentation/patient-consents.controller';
import {
  CreateConsentTemplateUseCase,
  ListConsentTemplatesUseCase,
  UpdateConsentTemplateUseCase,
} from './application/use-cases/consent-templates.use-cases';
import {
  CONSENT_CLOCK,
  ConsentDocumentRenderer,
  CountersignPatientConsentUseCase,
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
 * para el 404 de "paciente de otra clínica" del listado. DX-243: la firma del
 * profesional de los firmados a distancia, y exporta el render del documento
 * para el módulo de firma a distancia.
 */
@Module({
  imports: [JwtModule.register({}), PatientsModule, DocumentTypeNamesModule],
  controllers: [ConsentTemplatesController, PatientConsentsController],
  providers: [
    ListConsentTemplatesUseCase,
    CreateConsentTemplateUseCase,
    UpdateConsentTemplateUseCase,
    ListPatientConsentsUseCase,
    PreviewPatientConsentUseCase,
    SignPatientConsentUseCase,
    GetPatientConsentUseCase,
    CountersignPatientConsentUseCase,
    ConsentDocumentRenderer,
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
  // DX-243: la firma a distancia congela el texto con el mismo render.
  exports: [ConsentDocumentRenderer, CONSENT_TEMPLATE_REPOSITORY],
})
export class ConsentsModule {}
