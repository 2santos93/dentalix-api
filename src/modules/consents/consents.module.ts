import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { JobsModule } from '../jobs/jobs.module';
import {
  GenerateSignedConsentPdf,
  RetrySignedConsentPdfUseCase,
  SignedConsentPdfJobs,
  SignedConsentPdfQueue,
} from './application/signed-consent-pdf.service';
import {
  SIGNED_CONSENT_PDF_REPOSITORY,
  SIGNED_CONSENT_PDF_SCHEDULER,
} from './domain/ports/signed-consent-pdf-repository.port';
import {
  PdfkitSignedConsentPdfRenderer,
  SIGNED_CONSENT_PDF_RENDERER,
} from './infrastructure/pdf/signed-consent-pdf.renderer';
import { PrismaSignedConsentPdfRepository } from './infrastructure/repositories/prisma-signed-consent-pdf.repository';
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
 * para el módulo de firma a distancia. DX-422: genera en la cola el PDF firmado
 * de uno completo a distancia y lo archiva en los documentos del paciente.
 */
@Module({
  imports: [
    JwtModule.register({}),
    PatientsModule,
    DocumentTypeNamesModule,
    JobsModule,
    StorageModule,
  ],
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
    // DX-422: PDF firmado generado en el servidor y archivado en la ficha.
    GenerateSignedConsentPdf,
    RetrySignedConsentPdfUseCase,
    SignedConsentPdfJobs,
    SignedConsentPdfQueue,
    {
      provide: SIGNED_CONSENT_PDF_SCHEDULER,
      useExisting: SignedConsentPdfQueue,
    },
    {
      provide: SIGNED_CONSENT_PDF_REPOSITORY,
      useClass: PrismaSignedConsentPdfRepository,
    },
    {
      provide: SIGNED_CONSENT_PDF_RENDERER,
      useValue: new PdfkitSignedConsentPdfRenderer(),
    },
  ],
  // DX-243: la firma a distancia congela el texto con el mismo render.
  exports: [ConsentDocumentRenderer, CONSENT_TEMPLATE_REPOSITORY],
})
export class ConsentsModule {}
