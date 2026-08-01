import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CreatePaymentPlanUseCase } from './application/use-cases/create-payment-plan.use-case';
import {
  GetPaymentPlanUseCase,
  CLOCK,
} from './application/use-cases/get-payment-plan.use-case';
import { CancelPaymentPlanUseCase } from './application/use-cases/cancel-payment-plan.use-case';
import { PAYMENT_PLAN_REPOSITORY } from './domain/ports/payment-plan-repository.port';
import { PrismaPaymentPlanRepository } from './infrastructure/repositories/prisma-payment-plan.repository';
import { PaymentPlansController } from './presentation/payment-plans.controller';
import { PaymentsModule } from '../payments/payments.module';
import { TreatmentPlansModule } from '../treatment-plans/treatment-plans.module';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

// Imports PaymentsModule (para GetPlanBalanceUseCase, ahora exportado) y
// TreatmentPlansModule (para GetTreatmentPlanUseCase) — mismo patrón de DI
// cross-módulo que PaymentsModule.
@Module({
  imports: [JwtModule.register({}), PaymentsModule, TreatmentPlansModule],
  controllers: [PaymentPlansController],
  providers: [
    CreatePaymentPlanUseCase,
    GetPaymentPlanUseCase,
    CancelPaymentPlanUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: PAYMENT_PLAN_REPOSITORY, useClass: PrismaPaymentPlanRepository },
    // Real clock in production; specs inject a fixed one directly.
    { provide: CLOCK, useValue: () => new Date() },
  ],
})
export class PaymentPlansModule {}
