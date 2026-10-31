import { RecordSplitPaymentUseCase } from './application/use-cases/record-split-payment.use-case';
import { RecordOpeningBalancePaymentUseCase } from './application/use-cases/record-opening-balance-payment.use-case';
import { Module } from '@nestjs/common';
import { PaymentMethodsModule } from '../payment-methods/payment-methods.module';
import { PaymentMethodGate } from './application/payment-method-gate';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { JwtModule } from '@nestjs/jwt';
import { RecordPaymentUseCase } from './application/use-cases/record-payment.use-case';
import { ListPaymentsUseCase } from './application/use-cases/list-payments.use-case';
import {
  PAYMENT_CLOCK,
  VoidPaymentUseCase,
} from './application/use-cases/void-payment.use-case';
import { GetPlanBalanceUseCase } from './application/use-cases/get-plan-balance.use-case';
import { PLAN_CREDIT_READER } from './domain/ports/plan-credit-reader.port';
import { PrismaPlanCreditReader } from './infrastructure/credit/prisma-plan-credit-reader';
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
import { PaymentAllocationsModule } from './payment-allocations.module';
import { PaymentAllocationsController } from './presentation/payment-allocations.controller';
import { PaymentRateBacklogController } from './presentation/payment-rate-backlog.controller';
import { GetPaymentAllocationsUseCase } from './application/use-cases/get-payment-allocations.use-case';
import { ReplacePaymentAllocationsUseCase } from './application/use-cases/replace-payment-allocations.use-case';

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
    DocumentTypeNamesModule,
    TreatmentPlansModule,
    EmailModule,
    // DX-150: cerrar el compromiso de pago que cubre un abono.
    CollectionsModule,
    // DX-051: reparto de abonos entre ítems tras cada escritura.
    PaymentAllocationsModule,
    // DX-377: el catálogo de medios de pago de la clínica.
    PaymentMethodsModule,
  ],
  controllers: [
    PaymentsController,
    PaymentReceiptsController,
    // DX-051: ver y reasignar la imputación de un abono.
    PaymentAllocationsController,
    PaymentRateBacklogController,
  ],
  providers: [
    RecordPaymentUseCase,
    // DX-390: cobro dividido en varias formas de pago con un solo recibo.
    RecordSplitPaymentUseCase,
    // DX-262: abono contra el saldo migrado.
    RecordOpeningBalancePaymentUseCase,
    PaymentMethodGate,
    ListPaymentsUseCase,
    VoidPaymentUseCase,
    GetPlanBalanceUseCase,
    // DX-253: asientos del saldo a favor en el saldo del plan.
    { provide: PLAN_CREDIT_READER, useClass: PrismaPlanCreditReader },
    GetPaymentsTotalsUseCase,
    ListCashPaymentsUseCase,
    // DX-051: imputación de un abono a los ítems de su plan.
    GetPaymentAllocationsUseCase,
    ReplacePaymentAllocationsUseCase,
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
