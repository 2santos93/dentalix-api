import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  CreditPolicyUseCases,
  GetCreditRefundUseCase,
  ListPatientCreditUseCase,
  RefundCreditUseCase,
  TransferCreditUseCase,
} from './application/patient-credit.use-cases';
import { PATIENT_CREDIT_REPOSITORY } from './domain/ports/patient-credit-repository.port';
import { PrismaPatientCreditRepository } from './infrastructure/prisma-patient-credit.repository';
import { PatientCreditController } from './presentation/patient-credit.controller';

/** Saldo a favor del paciente (DX-253): traspaso y devolución. */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PatientCreditController],
  providers: [
    TransferCreditUseCase,
    RefundCreditUseCase,
    GetCreditRefundUseCase,
    ListPatientCreditUseCase,
    CreditPolicyUseCases,
    TokenService,
    TenantContextInterceptor,
    {
      provide: PATIENT_CREDIT_REPOSITORY,
      useClass: PrismaPatientCreditRepository,
    },
  ],
})
export class PatientCreditModule {}
