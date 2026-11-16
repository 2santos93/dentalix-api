import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { EmailModule } from '../notifications/email/email.module';
import {
  EXTERNAL_ORDER_COPY_EMAIL_SENDER,
  OutboxExternalOrderCopyEmailSender,
  PublicExternalOrderCopyUseCase,
  SendExternalOrderCopyUseCase,
} from './application/external-order-copies.use-cases';
import { ExternalOrderTemplatesUseCases } from './application/external-order-templates.use-cases';
import {
  EXTERNAL_ORDER_CLOCK,
  ExternalOrderSettingsUseCases,
  ExternalOrdersUseCases,
} from './application/external-orders.use-cases';
import {
  EXTERNAL_ORDER_COPY_CONFIG,
  loadExternalOrderCopyConfig,
} from './domain/external-order-copy-link';
import { EXTERNAL_ORDER_REPOSITORY } from './domain/ports/external-order-repository.port';
import {
  EXTERNAL_ORDER_PDF_RENDERER,
  PdfkitExternalOrderPdfRenderer,
} from './infrastructure/external-order-pdf.renderer';
import {
  EXTERNAL_ORDER_COPY_REPOSITORY,
  PrismaExternalOrderCopyRepository,
} from './infrastructure/prisma-external-order-copy.repository';
import {
  EXTERNAL_ORDER_TEMPLATE_REPOSITORY,
  PrismaExternalOrderTemplateRepository,
} from './infrastructure/prisma-external-order-template.repository';
import { PrismaExternalOrderRepository } from './infrastructure/prisma-external-order.repository';
import { ExternalOrderTemplatesController } from './presentation/external-order-templates.controller';
import {
  ExternalOrdersController,
  PatientExternalOrdersController,
} from './presentation/external-orders.controller';
import { PublicExternalOrderCopiesController } from './presentation/public-external-order-copies.controller';

/**
 * Órdenes de estudios y referencias a especialistas externos (DX-572): emitir
 * desde la ficha o la cita con foto inalterable, número por sede y PDF
 * archivado (sin la nota) en los documentos del paciente; anular; ligar y
 * desligar el resultado; «Órdenes sin resultado» con el plazo de la clínica;
 * plantillas de la clínica; y la copia para el paciente por un enlace de un
 * solo uso (email o WhatsApp) con su página pública.
 */
@Module({
  imports: [
    JwtModule.register({}),
    DocumentTypeNamesModule,
    StorageModule,
    EmailModule,
  ],
  controllers: [
    PatientExternalOrdersController,
    ExternalOrdersController,
    ExternalOrderTemplatesController,
    PublicExternalOrderCopiesController,
  ],
  providers: [
    ExternalOrdersUseCases,
    ExternalOrderSettingsUseCases,
    ExternalOrderTemplatesUseCases,
    SendExternalOrderCopyUseCase,
    PublicExternalOrderCopyUseCase,
    TenantContextInterceptor,
    PublicTenantContextInterceptor,
    TokenService,
    { provide: EXTERNAL_ORDER_CLOCK, useValue: () => new Date() },
    {
      provide: EXTERNAL_ORDER_REPOSITORY,
      useClass: PrismaExternalOrderRepository,
    },
    {
      provide: EXTERNAL_ORDER_COPY_REPOSITORY,
      useClass: PrismaExternalOrderCopyRepository,
    },
    {
      provide: EXTERNAL_ORDER_TEMPLATE_REPOSITORY,
      useClass: PrismaExternalOrderTemplateRepository,
    },
    {
      provide: EXTERNAL_ORDER_COPY_EMAIL_SENDER,
      useClass: OutboxExternalOrderCopyEmailSender,
    },
    {
      provide: EXTERNAL_ORDER_COPY_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loadExternalOrderCopyConfig((key) => config.get<string>(key)),
    },
    {
      provide: EXTERNAL_ORDER_PDF_RENDERER,
      useFactory: () => new PdfkitExternalOrderPdfRenderer(),
    },
  ],
})
export class ExternalOrdersModule {}
