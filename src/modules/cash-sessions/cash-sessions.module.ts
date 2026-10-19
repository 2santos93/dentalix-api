import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CASH_SESSIONS_CLOCK } from './application/cash-sessions-clock';
import {
  AddCashAdjustmentUseCase,
  CloseCashSessionUseCase,
  GetCashSessionUseCase,
  GetCashSettingsUseCase,
  GetCurrentCashSessionUseCase,
  ListCashSessionsUseCase,
  OpenCashSessionUseCase,
  ReopenCashSessionUseCase,
  UpdateCashSettingsUseCase,
} from './application/use-cases/cash-sessions.use-cases';
import { CASH_SESSION_REPOSITORY } from './domain/ports/cash-session-repository.port';
import { PrismaCashSessionRepository } from './infrastructure/prisma-cash-session.repository';
import { CashSessionsController } from './presentation/cash-sessions.controller';

/**
 * Caja por turno (DX-027): apertura con fondo, cierre con arqueo por moneda y
 * método, reapertura y correcciones del ADMIN, y los ajustes de caja de la
 * clínica. Lo que pasa dentro de las transacciones de los abonos (asociarlos
 * a la caja abierta y apuntar los ajustes de las cajas cerradas) vive en
 * `infrastructure/payment-cash-session.ts` y lo llama PrismaPaymentRepository.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [CashSessionsController],
  providers: [
    GetCashSettingsUseCase,
    UpdateCashSettingsUseCase,
    GetCurrentCashSessionUseCase,
    OpenCashSessionUseCase,
    ListCashSessionsUseCase,
    GetCashSessionUseCase,
    CloseCashSessionUseCase,
    ReopenCashSessionUseCase,
    AddCashAdjustmentUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: CASH_SESSION_REPOSITORY, useClass: PrismaCashSessionRepository },
    { provide: CASH_SESSIONS_CLOCK, useValue: () => new Date() },
  ],
})
export class CashSessionsModule {}
