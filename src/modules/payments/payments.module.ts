import { Module } from '@nestjs/common';
import { RecordPaymentUseCase } from './application/use-cases/record-payment.use-case';
import { ListPaymentsUseCase } from './application/use-cases/list-payments.use-case';
import { VoidPaymentUseCase } from './application/use-cases/void-payment.use-case';
import { GetPlanBalanceUseCase } from './application/use-cases/get-plan-balance.use-case';
import { GetPaymentsTotalsUseCase } from './application/use-cases/get-payments-totals.use-case';
import { PAYMENT_REPOSITORY } from './domain/ports/payment-repository.port';
import { PrismaPaymentRepository } from './infrastructure/repositories/prisma-payment.repository';
import { ExchangeModule } from '../exchange/exchange.module';
import { TreatmentPlansModule } from '../treatment-plans/treatment-plans.module';

// No controller/JwtModule yet — this module is use-cases + repo only
// (PAY-T2). REST (`PAYMENT_ROLES`, controller, DTOs) lands in PAY-T3, same
// as the plan's staged rollout. ExchangeModule is imported (not
// reimplemented) so RecordPayment/GetPlanBalance/GetPaymentsTotals can
// inject ConvertAmountUseCase; TreatmentPlansModule is imported so
// RecordPayment/GetPlanBalance can inject GetTreatmentPlanUseCase — same
// cross-module DI pattern SalesModule used for ExchangeModule.
@Module({
  imports: [ExchangeModule, TreatmentPlansModule],
  providers: [
    RecordPaymentUseCase,
    ListPaymentsUseCase,
    VoidPaymentUseCase,
    GetPlanBalanceUseCase,
    GetPaymentsTotalsUseCase,
    {
      provide: PAYMENT_REPOSITORY,
      useClass: PrismaPaymentRepository,
    },
  ],
  // Exported (additive) so DashboardModule can inject GetPaymentsTotalsUseCase
  // by class — same pattern as SalesModule exporting GetSalesTotalsUseCase.
  exports: [GetPaymentsTotalsUseCase],
})
export class PaymentsModule {}
