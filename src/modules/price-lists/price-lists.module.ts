import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { DentalCatalogModule } from '../dental-catalog/dental-catalog.module';
import { LocationsModule } from '../locations/locations.module';
import { CURRENCY_WHITELIST } from '../treatment-plans/domain/ports/currency-whitelist.port';
import { PrismaCurrencyWhitelist } from '../treatment-plans/infrastructure/adapters/prisma-currency-whitelist.adapter';
import { PriceListsController } from './presentation/price-lists.controller';
import {
  CreatePriceListUseCase,
  DeletePriceListUseCase,
  ListPriceListItemsUseCase,
  ListPriceListsUseCase,
  ReplacePriceListItemsUseCase,
  UpdatePriceListUseCase,
} from './application/use-cases/price-lists.use-cases';
import { PRICE_LIST_REPOSITORY } from './domain/ports/price-list-repository.port';
import { PrismaPriceListRepository } from './infrastructure/repositories/prisma-price-list.repository';

/**
 * Listas de precios por clínica y sede (DX-105). Exporta el repositorio para
 * que los convenios (lista viva y activa) y la resolución de precios del plan
 * (`priceFor`, `activeListForLocation`) lo usen sin re-implementarlo.
 */
@Module({
  imports: [JwtModule.register({}), DentalCatalogModule, LocationsModule],
  controllers: [PriceListsController],
  providers: [
    ListPriceListsUseCase,
    CreatePriceListUseCase,
    UpdatePriceListUseCase,
    DeletePriceListUseCase,
    ListPriceListItemsUseCase,
    ReplacePriceListItemsUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: PRICE_LIST_REPOSITORY, useClass: PrismaPriceListRepository },
    // Mismo adaptador que usan planes y abonos: la moneda sale de `currencies`.
    { provide: CURRENCY_WHITELIST, useClass: PrismaCurrencyWhitelist },
  ],
  exports: [PRICE_LIST_REPOSITORY],
})
export class PriceListsModule {}
