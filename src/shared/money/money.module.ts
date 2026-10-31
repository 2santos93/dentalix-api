import { Global, Module } from '@nestjs/common';
import { CURRENCY_DIGITS_CATALOG } from './currency-digits';
import { PrismaCurrencyDigitsCatalog } from './prisma-currency-digits.catalog';

/** DX-340: los decimales por moneda de `currencies`, para todos los módulos. */
@Global()
@Module({
  providers: [
    { provide: CURRENCY_DIGITS_CATALOG, useClass: PrismaCurrencyDigitsCatalog },
  ],
  exports: [CURRENCY_DIGITS_CATALOG],
})
export class MoneyModule {}
