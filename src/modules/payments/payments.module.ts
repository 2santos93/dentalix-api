import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RecordPaymentUseCase } from './application/use-cases/record-payment.use-case';
import { ListPaymentsUseCase } from './application/use-cases/list-payments.use-case';
import {
  PAYMENT_CLOCK,
  VoidPaymentUseCase,
} from './application/use-cases/void-payment.use-case';
import { GetPlanBalanceUseCase } from './application/use-cases/get-plan-balance.use-case';
import { GetPaymentsTotalsUseCase } from './application/use-cases/get-payments-totals.use-case';
import { ListCashPaymentsUseCase } from './application/use-cases/list-cash-payments.use-case';
import { PAYMENT_REPOSITORY } from './domain/ports/payment-repository.port';
import { PrismaPaymentRepository } from './infrastructure/repositories/prisma-payment.repository';
import { PaymentsController } from './presentation/payments.controller';
import { PaymentReceiptsController } from './presentation/payment-receipts.controller';
import { ReceiptPlanBalanceCalculator } from './application/receipts/receipt-plan-balance';
import { GetPaymentReceiptUseCase } from './application/receipts/get-payment-receipt.use-case';
import { SendPaymentReceiptUseCase } from './application/receipts/send-payment-receipt.use-case';
import { PAYMENT_RECEIPT_REPOSITORY } from './domain/ports/payment-receipt-repository.port';
import { RECEIPT_EMAIL_SENDER } from './domain/ports/receipt-email-sender.port';
import { PrismaPaymentReceiptRepository } from './infrastructure/repositories/prisma-payment-receipt.repository';
import { OutboxReceiptEmailSender } from './infrastructure/receipts/outbox-receipt-email-sender';
import { CollectionsModule } from '../collections/collections.module';
import { EmailModule } from '../notifications/email/email.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { TreatmentPlansModule } from '../treatment-plans/treatment-plans.module';
import { CURRENCY_WHITELIST } from '../treatment-plans/domain/ports/currency-whitelist.port';
import { PrismaCurrencyWhitelist } from '../treatment-plans/infrastructure/adapters/prisma-currency-whitelist.adapter';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

// REST lands here in PAY-T3 (`PAYMENT_ROLES`, controller, DTOs) on top of the
// use-cases + repo PAY-T2 already built. ExchangeModule is imported (not
// reimplemented) so RecordPayment/GetPlanBalance/GetPaymentsTotals can
// inject ConvertAmountUseCase; TreatmentPlansModule is imported so
// RecordPayment/GetPlanBalance can inject GetTreatmentPlanUseCase — same
// cross-module DI pattern SalesModule used for ExchangeModule.
@Module({
  // JwtModule.register({}) mirrors AppointmentsModule/DashboardModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on PaymentsController.
  // EmailModule (DX-136): el recibo se envía por el outbox de DX-088.
  imports: [
    JwtModule.register({}),
    ExchangeModule,
    TreatmentPlansModule,
    EmailModule,
    // DX-150: cerrar el compromiso de pago que cubre un abono.
    CollectionsModule,
  ],
  controllers: [PaymentsController, PaymentReceiptsController],
  providers: [
    RecordPaymentUseCase,
    ListPaymentsUseCase,
    VoidPaymentUseCase,
    GetPlanBalanceUseCase,
    GetPaymentsTotalsUseCase,
    ListCashPaymentsUseCase,
    // Recibo de caja numerado (DX-136).
    ReceiptPlanBalanceCalculator,
    GetPaymentReceiptUseCase,
    SendPaymentReceiptUseCase,
    {
      provide: PAYMENT_RECEIPT_REPOSITORY,
      useClass: PrismaPaymentReceiptRepository,
    },
    { provide: RECEIPT_EMAIL_SENDER, useClass: OutboxReceiptEmailSender },
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on PaymentsController.
    TenantContextInterceptor,
    {
      provide: PAYMENT_REPOSITORY,
      useClass: PrismaPaymentRepository,
    },
    // Reloj inyectable (mismo patrón que ACCOUNT_STATEMENT_CLOCK): la ventana
    // de anulación de recepción depende de "hoy".
    { provide: PAYMENT_CLOCK, useValue: () => new Date() },
    {
      provide: CURRENCY_WHITELIST,
      useClass: PrismaCurrencyWhitelist,
    },
  ],
  // Exported (additive) so DashboardModule can inject GetPaymentsTotalsUseCase
  // by class — same pattern as SalesModule exporting GetSalesTotalsUseCase.
  // GetPlanBalanceUseCase is also exported so PaymentPlansModule can inject it
  // (GetPaymentPlanUseCase reuses the same multi-currency "paid" math).
  exports: [GetPaymentsTotalsUseCase, GetPlanBalanceUseCase],
})
export class PaymentsModule {}
