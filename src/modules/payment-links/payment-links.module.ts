import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CollectionsModule } from '../collections/collections.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { EmailModule } from '../notifications/email/email.module';
import { PaymentMethodsModule } from '../payment-methods/payment-methods.module';
import { PaymentAllocationsModule } from '../payments/payment-allocations.module';
import { PaymentsModule } from '../payments/payments.module';
import {
  OutboxPaymentLinkEmails,
  PAYMENT_LINK_EMAILS,
} from './application/payment-link-emails';
import { PAYMENT_LINKS_CLOCK } from './application/payment-links-clock';
import {
  CreatePaymentLinkUseCase,
  ListPatientPaymentLinksUseCase,
} from './application/use-cases/patient-payment-links.use-cases';
import {
  ConfirmPaymentReportUseCase,
  CountPaymentReportsUseCase,
  GetPaymentReportProofUrlUseCase,
  ListPaymentReportsUseCase,
  RejectPaymentReportUseCase,
} from './application/use-cases/payment-reports.use-cases';
import {
  AuthorizePaymentLinkProofUploadUseCase,
  CompletePaymentLinkProofUploadUseCase,
  GetPublicPaymentLinkUseCase,
  MarkPaymentLinkOpenedUseCase,
  SubmitPaymentReportUseCase,
} from './application/use-cases/public-payment-links.use-cases';
import { PAYMENT_LINK_REPOSITORY } from './domain/ports/payment-link-repository.port';
import { PrismaPaymentLinkRepository } from './infrastructure/prisma-payment-link.repository';
import { PatientPaymentLinksController } from './presentation/patient-payment-links.controller';
import { PaymentReportsController } from './presentation/payment-reports.controller';
import { PublicPaymentLinksController } from './presentation/public-payment-links.controller';

/**
 * DX-569: el paciente reporta su pago por enlace. Enlaces de pago (ficha del
 * paciente), sus rutas públicas (ver, subir el comprobante y reportar) y la
 * bandeja «Pagos por confirmar» de Caja, que confirma con los casos de uso
 * del abono (PaymentsModule) o rechaza. Exporta el recuento para «Mi día».
 */
@Module({
  imports: [
    JwtModule.register({}),
    StorageModule,
    EmailModule,
    ExchangeModule,
    PaymentsModule,
    PaymentMethodsModule,
    PaymentAllocationsModule,
    CollectionsModule,
  ],
  controllers: [
    PatientPaymentLinksController,
    PublicPaymentLinksController,
    PaymentReportsController,
  ],
  providers: [
    CreatePaymentLinkUseCase,
    ListPatientPaymentLinksUseCase,
    GetPublicPaymentLinkUseCase,
    MarkPaymentLinkOpenedUseCase,
    AuthorizePaymentLinkProofUploadUseCase,
    CompletePaymentLinkProofUploadUseCase,
    SubmitPaymentReportUseCase,
    ListPaymentReportsUseCase,
    CountPaymentReportsUseCase,
    GetPaymentReportProofUrlUseCase,
    ConfirmPaymentReportUseCase,
    RejectPaymentReportUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: PAYMENT_LINK_REPOSITORY, useClass: PrismaPaymentLinkRepository },
    { provide: PAYMENT_LINK_EMAILS, useClass: OutboxPaymentLinkEmails },
    { provide: PAYMENT_LINKS_CLOCK, useValue: () => new Date() },
  ],
  exports: [CountPaymentReportsUseCase],
})
export class PaymentLinksModule {}
