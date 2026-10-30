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
import { JobsModule } from '../jobs/jobs.module';
import { ExchangePrefetchJobs } from './application/jobs/exchange-prefetch.jobs';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CLINIC_EXCHANGE_SETTINGS_REPOSITORY } from './domain/ports/clinic-exchange-settings-repository.port';
import { MANUAL_EXCHANGE_RATE_REPOSITORY } from './domain/ports/manual-exchange-rate-repository.port';
import { PrismaClinicExchangeSettingsRepository } from './infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from './infrastructure/repositories/prisma-manual-exchange-rate.repository';
import {
  GetExchangeRateSettingsUseCase,
  UpdateExchangeRateSettingsUseCase,
} from './application/use-cases/exchange-rate-settings.use-cases';
import {
  CorrectManualExchangeRateUseCase,
  ListManualExchangeRatesUseCase,
  EXCHANGE_RATE_CLOCK,
  RegisterManualExchangeRateUseCase,
} from './application/use-cases/manual-exchange-rates.use-cases';
import { ExchangeSettingsController } from './presentation/exchange-settings.controller';
import { ExchangeSourceChangeHooks } from './application/exchange-source-change-hooks';
import { ConfigService } from '@nestjs/config';
import {
  loadProviderRatesLimits,
  PROVIDER_RATES_LIMITS,
  ProviderRatesGate,
} from './application/provider-rates-gate';

// ConfigModule (ConfigService, used by OpenExchangeRatesProvider) and
// PrismaModule (PrismaService, used by PrismaExchangeRateRepository) are both
// @Global/isGlobal in this app (see config.module.ts / prisma.module.ts), so
// — same as PatientsModule/StaffModule — they don't need to be imported here.
@Module({
  // JwtModule.register({}) mirrors PatientsModule/StaffModule: JwtAuthGuard
  // depends on TokenService, which depends on JwtService — must be available
  // here since the guard is applied on this module's controller.
  // JobsModule: precarga diaria de los tipos de cambio (DX-085).
  imports: [JwtModule.register({}), JobsModule],
  // DX-374: fuente de la tasa de la clínica y tasas manuales (solo ADMIN).
  controllers: [ExchangeController, ExchangeSettingsController],
  providers: [
    // GetRatesForDateUseCase must be registered explicitly as a provider (not
    // only implicitly constructed): ConvertAmountUseCase injects it directly
    // (Task 2 note), and the controller also injects it for GET /exchange/rates.
    GetRatesForDateUseCase,
    ConvertAmountUseCase,
    TokenService,
    TenantContextInterceptor,
    ExchangePrefetchJobs,
    GetExchangeRateSettingsUseCase,
    UpdateExchangeRateSettingsUseCase,
    ListManualExchangeRatesUseCase,
    RegisterManualExchangeRateUseCase,
    CorrectManualExchangeRateUseCase,
    ExchangeSourceChangeHooks,
    { provide: EXCHANGE_RATE_CLOCK, useValue: () => new Date() },
    // SEC-054: caché negativa, single-flight y presupuestos de las llamadas
    // al proveedor (una instancia por proceso: compartida por todas las
    // clínicas). Un test cambia los topes con overrideProvider.
    ProviderRatesGate,
    {
      provide: PROVIDER_RATES_LIMITS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loadProviderRatesLimits((key) => config.get<string>(key)),
    },
    {
      provide: CLINIC_EXCHANGE_SETTINGS_REPOSITORY,
      useClass: PrismaClinicExchangeSettingsRepository,
    },
    {
      provide: MANUAL_EXCHANGE_RATE_REPOSITORY,
      useClass: PrismaManualExchangeRateRepository,
    },
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
  // DX-375: ExchangeSourceChangeHooks, para que los pagos congelen la tasa
  // de sus abonos pendientes antes de un cambio de fuente.
  exports: [ConvertAmountUseCase, ExchangeSourceChangeHooks],
})
export class ExchangeModule {}
