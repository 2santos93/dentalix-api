import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SalesController } from './presentation/sales.controller';
import { CreateSaleUseCase } from './application/use-cases/create-sale.use-case';
import { ListSalesUseCase } from './application/use-cases/list-sales.use-case';
import { GetSaleUseCase } from './application/use-cases/get-sale.use-case';
import { VoidSaleUseCase } from './application/use-cases/void-sale.use-case';
import { GetSalesTotalsUseCase } from './application/use-cases/get-sales-totals.use-case';
import { SALE_REPOSITORY } from './domain/ports/sale-repository.port';
import { PrismaSaleRepository } from './infrastructure/repositories/prisma-sale.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { ExchangeModule } from '../exchange/exchange.module';

@Module({
  // JwtModule.register({}) mirrors TreatmentPlansModule/AppointmentsModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService --
  // must be available here since the guard is applied on this module's
  // controller. ExchangeModule is imported (not re-implemented) so
  // GetSalesTotalsUseCase can inject ConvertAmountUseCase -- it now exports
  // that provider (see exchange.module.ts) for exactly this cross-module use
  // case, same pattern as TreatmentPlansModule importing DentalCatalogModule
  // for AddTreatmentPlanItemUseCase.
  imports: [JwtModule.register({}), ExchangeModule],
  controllers: [SalesController],
  providers: [
    CreateSaleUseCase,
    ListSalesUseCase,
    GetSaleUseCase,
    VoidSaleUseCase,
    GetSalesTotalsUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on SalesController.
    TenantContextInterceptor,
    {
      provide: SALE_REPOSITORY,
      useClass: PrismaSaleRepository,
    },
  ],
})
export class SalesModule {}
