import { Global, Module } from '@nestjs/common';
import { CURRENCY_DIGITS_CATALOG } from './currency-digits';
import { PrismaCurrencyDigitsCatalog } from './prisma-currency-digits.catalog';
import { ClinicCurrencyTextsReader } from './clinic-currency-texts.reader';

/** DX-340: los decimales por moneda de `currencies`, para todos los módulos. */
@Global()
@Module({
  providers: [
    { provide: CURRENCY_DIGITS_CATALOG, useClass: PrismaCurrencyDigitsCatalog },
    // DX-517: el texto propio de cada moneda de la clínica.
    ClinicCurrencyTextsReader,
  ],
  exports: [CURRENCY_DIGITS_CATALOG, ClinicCurrencyTextsReader],
})
export class MoneyModule {}
