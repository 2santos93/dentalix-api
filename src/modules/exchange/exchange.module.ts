import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EXCHANGE_RATE_PROVIDER } from './domain/ports/exchange-rate-provider.port';
import { OpenExchangeRatesProvider } from './infrastructure/providers/open-exchange-rates.provider';
import { EXCHANGE_RATE_REPOSITORY } from './domain/ports/exchange-rate-repository.port';
import { PrismaExchangeRateRepository } from './infrastructure/repositories/prisma-exchange-rate.repository';
import { GetRatesForDateUseCase } from './application/use-cases/get-rates-for-date.use-case';
import { ConvertAmountUseCase } from './application/use-cases/convert-amount.use-case';
import { ExchangeController } from './presentation/exchange.controller';
import { TokenService } from '../../shared/crypto/token.service';

// ConfigModule (ConfigService, used by OpenExchangeRatesProvider) and
// PrismaModule (PrismaService, used by PrismaExchangeRateRepository) are both
// @Global/isGlobal in this app (see config.module.ts / prisma.module.ts), so
// — same as PatientsModule/StaffModule — they don't need to be imported here.
@Module({
  // JwtModule.register({}) mirrors PatientsModule/StaffModule: JwtAuthGuard
  // depends on TokenService, which depends on JwtService — must be available
  // here since the guard is applied on this module's controller.
  imports: [JwtModule.register({})],
  controllers: [ExchangeController],
  providers: [
    // GetRatesForDateUseCase must be registered explicitly as a provider (not
    // only implicitly constructed): ConvertAmountUseCase injects it directly
    // (Task 2 note), and the controller also injects it for GET /exchange/rates.
    GetRatesForDateUseCase,
    ConvertAmountUseCase,
    TokenService,
    {
      provide: EXCHANGE_RATE_PROVIDER,
      useClass: OpenExchangeRatesProvider,
    },
    {
      provide: EXCHANGE_RATE_REPOSITORY,
      useClass: PrismaExchangeRateRepository,
    },
  ],
  // Exported so other modules (PaymentsModule -> RecordPayment/GetPlanBalance/
  // GetPaymentsTotals) can inject ConvertAmountUseCase to convert each
  // payment at its own paidAt date without duplicating the exchange
  // lookup/conversion logic.
  exports: [ConvertAmountUseCase],
})
export class ExchangeModule {}
