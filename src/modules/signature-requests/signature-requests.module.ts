import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { ConsentsModule } from '../consents/consents.module';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { EmailModule } from '../notifications/email/email.module';
import {
  SIGNATURE_CLOCK,
  SIGNATURE_CODE_KEY,
} from './application/signature-clock';
import {
  OutboxSignatureEmailSender,
  SIGNATURE_EMAIL_SENDER,
} from './application/signature-email';
import {
  GetPublicSignatureDocumentUseCase,
  GetPublicSignatureUseCase,
  RequestSignatureCodeUseCase,
  SignPublicSignatureUseCase,
  VerifySignatureCodeUseCase,
} from './application/use-cases/public-signature.use-cases';
import {
  CreateSignatureRequestUseCase,
  GetSignatureRequestOptionsUseCase,
  ListPatientSignatureRequestsUseCase,
  RevokeSignatureRequestUseCase,
} from './application/use-cases/signature-requests.use-cases';
import { deriveSignatureCodeKey } from './domain/signature-code';
import { SIGNATURE_REQUEST_REPOSITORY } from './domain/ports/signature-request-repository.port';
import { PrismaSignatureRequestRepository } from './infrastructure/prisma-signature-request.repository';
import { PatientSignatureRequestsController } from './presentation/patient-signature-requests.controller';
import { PublicSignatureController } from './presentation/public-signature.controller';

/**
 * DX-243: firma a distancia por enlace con código de verificación. Rutas del
 * personal (opciones del modal, enviar, listar, anular) y públicas del
 * paciente (estado, código, verificación, documento y firma). La firma del
 * profesional que completa el consentimiento vive en ConsentsModule.
 */
@Module({
  imports: [
    JwtModule.register({}),
    ConsentsModule,
    DocumentTypeNamesModule,
    EmailModule,
  ],
  controllers: [PatientSignatureRequestsController, PublicSignatureController],
  providers: [
    GetSignatureRequestOptionsUseCase,
    CreateSignatureRequestUseCase,
    ListPatientSignatureRequestsUseCase,
    RevokeSignatureRequestUseCase,
    GetPublicSignatureUseCase,
    RequestSignatureCodeUseCase,
    VerifySignatureCodeUseCase,
    GetPublicSignatureDocumentUseCase,
    SignPublicSignatureUseCase,
    { provide: SIGNATURE_CLOCK, useValue: () => new Date() },
    {
      // HMAC del código con una clave derivada de un secreto del servidor
      // (JWT_ACCESS_SECRET, validado al arrancar): nunca vive en la base.
      provide: SIGNATURE_CODE_KEY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Buffer =>
        deriveSignatureCodeKey(config.getOrThrow<string>('JWT_ACCESS_SECRET')),
    },
    {
      provide: SIGNATURE_REQUEST_REPOSITORY,
      useClass: PrismaSignatureRequestRepository,
    },
    { provide: SIGNATURE_EMAIL_SENDER, useClass: OutboxSignatureEmailSender },
    TokenService,
    TenantContextInterceptor,
    PublicTenantContextInterceptor,
  ],
})
export class SignatureRequestsModule {}
