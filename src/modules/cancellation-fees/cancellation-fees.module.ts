import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PaymentAllocationsModule } from '../payments/payment-allocations.module';
import { CancellationFeeController } from './presentation/cancellation-fee.controller';
import {
  ChargeCancellationFeeUseCase,
  GetCancellationFeeUseCase,
  VoidCancellationFeeUseCase,
  WaiveCancellationFeeUseCase,
} from './application/cancellation-fee.use-cases';
import { CANCELLATION_FEE_REPOSITORY } from './domain/ports/cancellation-fee-repository.port';
import { PrismaCancellationFeeRepository } from './infrastructure/prisma-cancellation-fee.repository';

/**
 * DX-291: cargo por inasistencia o cancelación tardía y su condonación (y su
 * anulación con motivo, SEC-050). El
 * cargo es un ítem del plan «Cargos administrativos» y se cobra con el abono
 * y el recibo de siempre (módulo payments).
 */
@Module({
  // DX-051: el cargo y su anulación drenan el reparto de abonos del plan.
  imports: [JwtModule.register({}), PaymentAllocationsModule],
  controllers: [CancellationFeeController],
  providers: [
    GetCancellationFeeUseCase,
    ChargeCancellationFeeUseCase,
    WaiveCancellationFeeUseCase,
    VoidCancellationFeeUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: CANCELLATION_FEE_REPOSITORY,
      useClass: PrismaCancellationFeeRepository,
    },
  ],
})
export class CancellationFeesModule {}
