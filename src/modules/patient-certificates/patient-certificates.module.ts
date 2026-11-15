import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  CERTIFICATE_COPY_CLOCK,
  GetPublicCertificateCopyUseCase,
  SendCertificateCopyUseCase,
} from './application/certificate-copies.use-cases';
import {
  CERTIFICATE_COPY_CONFIG,
  loadCertificateCopyConfig,
} from './domain/certificate-copy-link';
import {
  CERTIFICATE_COPY_REPOSITORY,
  PrismaCertificateCopyRepository,
} from './infrastructure/prisma-certificate-copy.repository';
import { PublicCertificateCopiesController } from './presentation/public-certificate-copies.controller';
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
 * «Enviar por WhatsApp» una copia por enlace caducable y su página pública.
 */
@Module({
  imports: [JwtModule.register({}), DocumentTypeNamesModule, StorageModule],
  controllers: [
    PatientCertificatesController,
    CertificateSettingsController,
    PublicCertificateCopiesController,
  ],
  providers: [
    PatientCertificatesUseCases,
    CertificateSettingsUseCases,
    TenantContextInterceptor,
    TokenService,
    PublicTenantContextInterceptor,
    SendCertificateCopyUseCase,
    GetPublicCertificateCopyUseCase,
    { provide: CERTIFICATE_COPY_CLOCK, useValue: () => new Date() },
    {
      provide: CERTIFICATE_COPY_REPOSITORY,
      useClass: PrismaCertificateCopyRepository,
    },
    {
      provide: CERTIFICATE_COPY_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loadCertificateCopyConfig((key) => config.get<string>(key)),
    },
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
