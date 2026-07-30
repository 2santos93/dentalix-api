import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RecordPaymentUseCase } from './application/use-cases/record-payment.use-case';
import { ListPaymentsUseCase } from './application/use-cases/list-payments.use-case';
import { VoidPaymentUseCase } from './application/use-cases/void-payment.use-case';
import { GetPlanBalanceUseCase } from './application/use-cases/get-plan-balance.use-case';
import { GetPaymentsTotalsUseCase } from './application/use-cases/get-payments-totals.use-case';
import { PAYMENT_REPOSITORY } from './domain/ports/payment-repository.port';
import { PrismaPaymentRepository } from './infrastructure/repositories/prisma-payment.repository';
import { PaymentsController } from './presentation/payments.controller';
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
  imports: [JwtModule.register({}), ExchangeModule, TreatmentPlansModule],
  controllers: [PaymentsController],
  providers: [
    RecordPaymentUseCase,
    ListPaymentsUseCase,
    VoidPaymentUseCase,
    GetPlanBalanceUseCase,
    GetPaymentsTotalsUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on PaymentsController.
    TenantContextInterceptor,
    {
      provide: PAYMENT_REPOSITORY,
      useClass: PrismaPaymentRepository,
    },
    {
      provide: CURRENCY_WHITELIST,
      useClass: PrismaCurrencyWhitelist,
    },
  ],
  // Exported (additive) so DashboardModule can inject GetPaymentsTotalsUseCase
  // by class — same pattern as SalesModule exporting GetSalesTotalsUseCase.
  exports: [GetPaymentsTotalsUseCase],
})
export class PaymentsModule {}
