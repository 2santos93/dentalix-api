import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import {
  ACCOUNT_STATEMENT_CLOCK,
  GetAccountStatementUseCase,
} from './application/use-cases/get-account-statement.use-case';
import { ListBillablePlansUseCase } from './application/use-cases/list-billable-plans.use-case';
import { GetFamilyAccountStatementUseCase } from './application/use-cases/get-family-account-statement.use-case';
import { STATEMENT_FAMILY_REPOSITORY } from './domain/ports/statement-family-repository.port';
import { PrismaStatementFamilyRepository } from './infrastructure/repositories/prisma-statement-family.repository';
import { ACCOUNT_STATEMENT_REPOSITORY } from './domain/ports/account-statement-repository.port';
import { PrismaAccountStatementRepository } from './infrastructure/repositories/prisma-account-statement.repository';
import { AccountStatementController } from './presentation/account-statement.controller';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

// Estado de cuenta del paciente (DX-011). Módulo de solo lectura con su propio
// repositorio: lee planes, abonos y cuotas en pocas consultas agregadas en vez
// de componer los casos de uso por plan (que harían una ronda por plan y una
// conversión por abono). Reutiliza la lógica pura de estados de cuota
// (deriveStatuses) del módulo payment-plans, sin depender de su DI.
@Module({
  // JwtModule.register({}): JwtAuthGuard -> TokenService -> JwtService, igual
  // que PaymentsModule.
  imports: [JwtModule.register({})],
  controllers: [AccountStatementController],
  providers: [
    GetAccountStatementUseCase,
    ListBillablePlansUseCase,
    // DX-203: destinatario del estado de cuenta y estado de cuenta familiar.
    GetFamilyAccountStatementUseCase,
    {
      provide: STATEMENT_FAMILY_REPOSITORY,
      useClass: PrismaStatementFamilyRepository,
    },
    TokenService,
    TenantContextInterceptor,
    {
      provide: ACCOUNT_STATEMENT_REPOSITORY,
      useClass: PrismaAccountStatementRepository,
    },
    { provide: ACCOUNT_STATEMENT_CLOCK, useValue: () => new Date() },
  ],
})
export class AccountStatementModule {}
