import { Module } from '@nestjs/common';
import { ExchangeModule } from '../exchange/exchange.module';
import { PlanBalanceCalculator } from './application/plan-balance-calculator';

/**
 * DX-472-bis: la cuenta del saldo de un plan (`PlanBalanceCalculator`) para
 * los módulos que no pueden importar PaymentsModule: la cartera y la cobranza
 * (PaymentsModule importa CollectionsModule). Solo trae el convertidor.
 */
@Module({
  imports: [ExchangeModule],
  providers: [PlanBalanceCalculator],
  exports: [PlanBalanceCalculator],
})
export class PlanBalanceModule {}
