import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CollectionsModule } from '../collections/collections.module';
import { PatientsController } from './presentation/patients.controller';
import { PatientCommunicationController } from './presentation/patient-communication.controller';
import { PatientResponsiblePartiesController } from './presentation/patient-responsible-parties.controller';
import { PatientMajorityReviewController } from './presentation/patient-majority-review.controller';
import {
  GetMajorityReviewUseCase,
  ListComingOfAgeUseCase,
  ReviewMajorityUseCase,
} from './application/use-cases/majority-review.use-cases';
import { MAJORITY_REVIEW_REPOSITORY } from './domain/ports/majority-review-repository.port';
import { PrismaMajorityReviewRepository } from './infrastructure/repositories/prisma-majority-review.repository';
import {
  CreateResponsiblePartyUseCase,
  ListResponsiblePartiesUseCase,
  RemoveResponsiblePartyUseCase,
  RESPONSIBLES_CLOCK,
  UpdateResponsiblePartyUseCase,
} from './application/use-cases/responsible-parties.use-cases';
import { RESPONSIBLE_PARTY_REPOSITORY } from './domain/ports/responsible-party-repository.port';
import { PrismaResponsiblePartyRepository } from './infrastructure/repositories/prisma-responsible-party.repository';
import {
  COMMUNICATION_CLOCK,
  GetPatientCommunicationUseCase,
  GetPatientOptOutWarningsUseCase,
  UpdatePatientCommunicationUseCase,
} from './application/use-cases/patient-communication.use-cases';
import { PATIENT_COMMUNICATION_REPOSITORY } from './domain/ports/patient-communication-repository.port';
import { DefaultPhoneRegionReader } from './domain/ports/default-phone-region-reader.port';
import { PrismaPatientCommunicationRepository } from './infrastructure/repositories/prisma-patient-communication.repository';
import { CreatePatientUseCase } from './application/use-cases/create-patient.use-case';
import { ListPatientsUseCase } from './application/use-cases/list-patients.use-case';
import { CountPatientsUseCase } from './application/use-cases/count-patients.use-case';
import { GetPatientUseCase } from './application/use-cases/get-patient.use-case';
import { UpdatePatientUseCase } from './application/use-cases/update-patient.use-case';
import {
  ArchivePatientUseCase,
  CountPatientLivePublicLinksUseCase,
  ListRetentionExpiringUseCase,
  PartiallySuppressPatientUseCase,
  RETENTION_CLOCK,
  SetRetentionExtensionUseCase,
} from './application/use-cases/retention.use-cases';
import {
  GetPatientSettingsUseCase,
  UpdatePatientSettingsUseCase,
} from './application/use-cases/patient-settings.use-cases';
import {
  GetPatientLanguagesUseCase,
  UpdatePatientLanguagesUseCase,
} from './application/use-cases/patient-languages.use-cases';
import { PATIENT_SETTINGS_REPOSITORY } from './domain/ports/patient-settings-repository.port';
import { PrismaPatientSettingsRepository } from './infrastructure/repositories/prisma-patient-settings.repository';
import {
  GetRetentionSettingsUseCase,
  UpdateRetentionSettingsUseCase,
} from './application/use-cases/retention-settings.use-cases';
import { CLINIC_RETENTION_SETTINGS_REPOSITORY } from './domain/ports/clinic-retention-settings-repository.port';
import { PrismaClinicRetentionSettingsRepository } from './infrastructure/repositories/prisma-clinic-retention-settings.repository';
import {
  GetDocumentTypeNamesUseCase,
  UpdateDocumentTypeNamesUseCase,
} from './application/use-cases/document-type-names.use-cases';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { PATIENT_REPOSITORY } from './domain/ports/patient-repository.port';
import { clinicalRetentionConfigProvider } from './domain/retention/clinical-retention-config';
import { PATIENT_PUBLIC_LINKS_READER } from './domain/ports/patient-public-links.port';
import { PrismaPatientPublicLinksRepository } from './infrastructure/repositories/prisma-patient-public-links.repository';
import { PrismaPatientRepository } from './infrastructure/repositories/prisma-patient.repository';
import { REFERENCE_LOOKUP } from './domain/ports/reference-lookup.port';
import { PrismaReferenceLookup } from './infrastructure/adapters/prisma-reference-lookup.adapter';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

import { JobsModule } from '../jobs/jobs.module';
import { PatientPhoneE164Jobs } from './infrastructure/patient-phone-e164.jobs';
import { PatientCoveragesModule } from '../patient-coverages/patient-coverages.module';
import { PatientAgreementsModule } from '../patient-agreements/patient-agreements.module';

@Module({
  // JwtModule.register({}) mirrors AuthModule: JwtAuthGuard depends on
  // TokenService, which depends on JwtService — must be available here since
  // the guard is applied on this module's controller.
  // DX-105: PatientAgreementsModule da el resumen `agreement` de la ficha.
  // DX-153: PatientCoveragesModule da el resumen `coverage` de la ficha y el listado.
  // DX-150: CollectionsModule da la marca «Saldo vencido» de la ficha.
  imports: [
    JwtModule.register({}),
    // DX-224: trabajo que rellena `phoneE164` (barrido horario + al arrancar).
    JobsModule,
    CollectionsModule,
    PatientCoveragesModule,
    PatientAgreementsModule,
    // DX-327: nombres locales de los tipos de documento (lector y repositorio).
    DocumentTypeNamesModule,
  ],
  controllers: [
    // DX-342: antes que PatientsController, para que `GET
    // /patients/coming-of-age` no caiga en `GET /patients/:id`.
    PatientMajorityReviewController,
    PatientsController,
    PatientCommunicationController,
    PatientResponsiblePartiesController,
  ],
  providers: [
    CreatePatientUseCase,
    ListPatientsUseCase,
    CountPatientsUseCase,
    GetPatientUseCase,
    UpdatePatientUseCase,
    ArchivePatientUseCase,
    CountPatientLivePublicLinksUseCase,
    SetRetentionExtensionUseCase,
    PartiallySuppressPatientUseCase,
    ListRetentionExpiringUseCase,
    { provide: RETENTION_CLOCK, useValue: () => new Date() },
    // DX-330: mínimo de plataforma del plazo de conservación de la HC.
    clinicalRetentionConfigProvider,
    // DX-128: bloque «Comunicaciones» de la ficha.
    GetPatientCommunicationUseCase,
    GetPatientOptOutWarningsUseCase,
    UpdatePatientCommunicationUseCase,
    { provide: COMMUNICATION_CLOCK, useValue: () => new Date() },
    // DX-203: bloque «Responsable y familia».
    ListResponsiblePartiesUseCase,
    CreateResponsiblePartyUseCase,
    UpdateResponsiblePartyUseCase,
    RemoveResponsiblePartyUseCase,
    { provide: RESPONSIBLES_CLOCK, useValue: () => new Date() },
    // DX-342: paso a la mayoría de edad con responsable.
    ListComingOfAgeUseCase,
    GetMajorityReviewUseCase,
    ReviewMajorityUseCase,
    {
      provide: MAJORITY_REVIEW_REPOSITORY,
      useClass: PrismaMajorityReviewRepository,
    },
    // DX-328: mayoría de edad de la clínica (Ajustes).
    GetPatientSettingsUseCase,
    UpdatePatientSettingsUseCase,
    GetPatientLanguagesUseCase,
    UpdatePatientLanguagesUseCase,
    {
      provide: PATIENT_SETTINGS_REPOSITORY,
      useClass: PrismaPatientSettingsRepository,
    },
    // DX-330: plazo de conservación de la HC de la clínica (Ajustes).
    GetRetentionSettingsUseCase,
    UpdateRetentionSettingsUseCase,
    {
      provide: CLINIC_RETENTION_SETTINGS_REPOSITORY,
      useClass: PrismaClinicRetentionSettingsRepository,
    },
    // DX-327: nombre local de cada tipo de documento (Ajustes).
    GetDocumentTypeNamesUseCase,
    UpdateDocumentTypeNamesUseCase,
    {
      provide: RESPONSIBLE_PARTY_REPOSITORY,
      useClass: PrismaResponsiblePartyRepository,
    },
    {
      provide: PATIENT_COMMUNICATION_REPOSITORY,
      useClass: PrismaPatientCommunicationRepository,
    },
    // DX-387: la misma lectura de la región, para el `phoneInternational` de
    // pacientes y responsables (una vez por petición).
    {
      provide: DefaultPhoneRegionReader,
      useExisting: PATIENT_COMMUNICATION_REPOSITORY,
    },
    PatientPhoneE164Jobs,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on PatientsController.
    TenantContextInterceptor,
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    // DX-461: enlaces públicos vivos que anularía archivar.
    {
      provide: PATIENT_PUBLIC_LINKS_READER,
      useClass: PrismaPatientPublicLinksRepository,
    },
    { provide: REFERENCE_LOOKUP, useClass: PrismaReferenceLookup },
  ],
  // CountPatientsUseCase exportado para el `patientCount` del dashboard: un
  // COUNT, no una página de pacientes (DX-043, DB-008).
  // PATIENT_REPOSITORY exportado (aditivo) para que CreateAppointmentUseCase
  // valide que el paciente sea de ESTA clínica — mismo patrón cross-module que
  // DentalCatalogModule exportando su repo.
  exports: [CountPatientsUseCase, PATIENT_REPOSITORY],
})
export class PatientsModule {}
