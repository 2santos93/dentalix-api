import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  FINANCIAL_LOCK_CLOCK,
  GetFinancialLockUseCase,
  GetPeriodLockUseCase,
  UpdateFinancialLockUseCase,
} from './application/financial-lock.use-cases';
import { FINANCIAL_LOCK_REPOSITORY } from './domain/ports/financial-lock-repository.port';
import { PrismaFinancialLockRepository } from './infrastructure/prisma-financial-lock.repository';
import {
  FinancialLockSettingsController,
  PeriodLockController,
} from './presentation/financial-lock.controller';

/**
 * DX-091: cierre contable. Ajustes y excepciones aquí; la regla la aplican
 * los repositorios de abonos y planes de cuotas con `financial-lock-tx` (y la
 * BD repite la de abonos).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [FinancialLockSettingsController, PeriodLockController],
  providers: [
    GetFinancialLockUseCase,
    UpdateFinancialLockUseCase,
    GetPeriodLockUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: FINANCIAL_LOCK_REPOSITORY,
      useClass: PrismaFinancialLockRepository,
    },
    { provide: FINANCIAL_LOCK_CLOCK, useValue: () => new Date() },
  ],
  exports: [FINANCIAL_LOCK_REPOSITORY],
})
export class FinancialLockModule {}
