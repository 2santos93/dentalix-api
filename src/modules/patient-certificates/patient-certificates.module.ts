import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import {
  CertificateSettingsUseCases,
  PatientCertificatesUseCases,
} from './application/patient-certificates.use-cases';
import { PATIENT_CERTIFICATE_REPOSITORY } from './domain/ports/patient-certificate-repository.port';
import {
  CERTIFICATE_PDF_RENDERER,
  PdfkitCertificatePdfRenderer,
} from './infrastructure/certificate-pdf.renderer';
import { PrismaPatientCertificateRepository } from './infrastructure/prisma-patient-certificate.repository';
import {
  CertificateSettingsController,
  PatientCertificatesController,
} from './presentation/patient-certificates.controller';

/**
 * Certificados del paciente (DX-306): justificante de asistencia y
 * certificado de reposo de una cita atendida, con foto inalterable, número
 * por sede, PDF archivado en los documentos del paciente y anulación con
 * motivo. Ajustes por clínica (máximo de días, si imprime el diagnóstico).
 */
@Module({
  imports: [JwtModule.register({}), DocumentTypeNamesModule, StorageModule],
  controllers: [PatientCertificatesController, CertificateSettingsController],
  providers: [
    PatientCertificatesUseCases,
    CertificateSettingsUseCases,
    TenantContextInterceptor,
    TokenService,
    {
      provide: PATIENT_CERTIFICATE_REPOSITORY,
      useClass: PrismaPatientCertificateRepository,
    },
    {
      provide: CERTIFICATE_PDF_RENDERER,
      useFactory: () => new PdfkitCertificatePdfRenderer(),
    },
  ],
})
export class PatientCertificatesModule {}
