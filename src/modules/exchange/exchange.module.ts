import { Module } from '@nestjs/common';
import { EXCHANGE_RATE_PROVIDER } from './domain/ports/exchange-rate-provider.port';
import { OpenExchangeRatesProvider } from './infrastructure/providers/open-exchange-rates.provider';

// Minimal wiring for the provider port. Use cases, repository and
// controller land in Task 2/3 — not registered in AppModule yet.
@Module({
  providers: [
    {
      provide: EXCHANGE_RATE_PROVIDER,
      useClass: OpenExchangeRatesProvider,
    },
  ],
  exports: [EXCHANGE_RATE_PROVIDER],
})
export class ExchangeModule {}
