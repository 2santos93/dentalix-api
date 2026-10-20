import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';
import {
  GetPatientDocumentUrlUseCase,
  GetPatientDocumentUseCase,
  ListPatientDocumentsUseCase,
  PATIENT_DOCUMENT_CLOCK,
  PATIENT_DOCUMENT_URL_TTL,
  UploadPatientDocumentUseCase,
  VoidPatientDocumentUseCase,
} from './application/use-cases/patient-documents.use-cases';
import { PATIENT_DOCUMENT_URL_TTL_SECONDS } from './domain/document-rules';
import { PATIENT_DOCUMENT_REPOSITORY } from './domain/ports/patient-document-repository.port';
import { PrismaPatientDocumentRepository } from './infrastructure/repositories/prisma-patient-document.repository';
import { PatientDocumentsController } from './presentation/patient-documents.controller';

/**
 * Documentos del paciente (DX-151): radiografías, fotos, remisiones,
 * consentimientos escaneados e informes en la ficha. Contenido comprobado
 * (lista blanca por contenido), almacén privado con URL firmadas de corta
 * vida para ver o descargar, anulación con motivo y auditoría de cada acceso.
 */
@Module({
  imports: [JwtModule.register({}), StorageModule, PatientsModule],
  controllers: [PatientDocumentsController],
  providers: [
    UploadPatientDocumentUseCase,
    ListPatientDocumentsUseCase,
    GetPatientDocumentUseCase,
    GetPatientDocumentUrlUseCase,
    VoidPatientDocumentUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: PATIENT_DOCUMENT_CLOCK, useValue: () => new Date() },
    {
      provide: PATIENT_DOCUMENT_URL_TTL,
      useValue: PATIENT_DOCUMENT_URL_TTL_SECONDS,
    },
    {
      provide: PATIENT_DOCUMENT_REPOSITORY,
      useClass: PrismaPatientDocumentRepository,
    },
  ],
})
export class PatientDocumentsModule {}
