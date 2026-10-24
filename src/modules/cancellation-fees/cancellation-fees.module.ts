import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CancellationFeeController } from './presentation/cancellation-fee.controller';
import {
  CANCELLATION_FEE_EPS_CO_BLOCK,
  ChargeCancellationFeeUseCase,
  GetCancellationFeeUseCase,
  WaiveCancellationFeeUseCase,
} from './application/cancellation-fee.use-cases';
import { CANCELLATION_FEE_REPOSITORY } from './domain/ports/cancellation-fee-repository.port';
import { PrismaCancellationFeeRepository } from './infrastructure/prisma-cancellation-fee.repository';
import { epsCoBlockEnabled } from './domain/cancellation-fee';

/**
 * DX-291: cargo por inasistencia o cancelación tardía y su condonación. El
 * cargo es un ítem del plan «Cargos administrativos» y se cobra con el abono
 * y el recibo de siempre (módulo payments). El bloqueo por EPS_CO lo fija la
 * plataforma con `CANCELLATION_FEE_BLOCK_EPS_CO` (activado salvo `false`).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [CancellationFeeController],
  providers: [
    GetCancellationFeeUseCase,
    ChargeCancellationFeeUseCase,
    WaiveCancellationFeeUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: CANCELLATION_FEE_REPOSITORY,
      useClass: PrismaCancellationFeeRepository,
    },
    {
      provide: CANCELLATION_FEE_EPS_CO_BLOCK,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        epsCoBlockEnabled(config.get<string>('CANCELLATION_FEE_BLOCK_EPS_CO')),
    },
  ],
})
export class CancellationFeesModule {}
