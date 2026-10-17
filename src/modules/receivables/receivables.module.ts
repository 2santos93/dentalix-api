import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import {
  GetReceivablesAgingUseCase,
  RECEIVABLES_CLOCK,
} from './application/use-cases/get-receivables-aging.use-case';
import { RECEIVABLES_REPOSITORY } from './domain/ports/receivables-repository.port';
import { PrismaReceivablesRepository } from './infrastructure/prisma-receivables.repository';
import { ReceivablesController } from './presentation/receivables.controller';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

// Cartera por antigüedad (DX-145). Solo lectura, con su propio repositorio de
// consultas agregadas (sin N+1). El saldo NO se recalcula aquí: usa la función
// pura `computeBalances` del estado de cuenta (DX-011), igual que este reutiliza
// `deriveStatuses` de payment-plans, sin depender de su DI.
@Module({
  // JwtModule.register({}): JwtAuthGuard -> TokenService -> JwtService, igual
  // que AccountStatementModule.
  imports: [JwtModule.register({})],
  controllers: [ReceivablesController],
  providers: [
    GetReceivablesAgingUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: RECEIVABLES_REPOSITORY,
      useClass: PrismaReceivablesRepository,
    },
    { provide: RECEIVABLES_CLOCK, useValue: () => new Date() },
  ],
})
export class ReceivablesModule {}
