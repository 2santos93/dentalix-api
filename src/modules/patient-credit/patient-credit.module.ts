import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PaymentAllocationsModule } from '../payments/payment-allocations.module';
import {
  CreditPolicyUseCases,
  GetCreditRefundUseCase,
  ListPatientCreditUseCase,
  RefundCreditUseCase,
  TransferCreditUseCase,
} from './application/patient-credit.use-cases';
import {
  PATIENT_CREDIT_CLOCK,
  PATIENT_CREDIT_REPOSITORY,
} from './domain/ports/patient-credit-repository.port';
import { PrismaPatientCreditRepository } from './infrastructure/prisma-patient-credit.repository';
import { PatientCreditController } from './presentation/patient-credit.controller';

/** Saldo a favor del paciente (DX-253): traspaso y devolución. */
@Module({
  // DX-399-ter (N1): el traspaso drena el reparto que encola (interceptor).
  imports: [JwtModule.register({}), PaymentAllocationsModule],
  controllers: [PatientCreditController],
  providers: [
    TransferCreditUseCase,
    RefundCreditUseCase,
    GetCreditRefundUseCase,
    ListPatientCreditUseCase,
    CreditPolicyUseCases,
    TokenService,
    TenantContextInterceptor,
    { provide: PATIENT_CREDIT_CLOCK, useValue: () => new Date() },
    {
      provide: PATIENT_CREDIT_REPOSITORY,
      useClass: PrismaPatientCreditRepository,
    },
  ],
})
export class PatientCreditModule {}
