import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { GetRatesForDateUseCase } from '../../exchange/application/use-cases/get-rates-for-date.use-case';
import type {
  BudgetSecondCurrencySource,
  StoredDayRates,
} from '../application/budget-presentation';

/**
 * DX-560: la segunda moneda del enlace de aceptación (regla en
 * `secondCurrencyFor`): el catálogo de monedas para validar la elegida y la
 * tasa que la clínica YA tiene guardada ese día (`stored()`, DX-569). Nunca
 * llama al proveedor de tasas.
 */
@Injectable()
export class PrismaBudgetSecondCurrency implements BudgetSecondCurrencySource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: GetRatesForDateUseCase,
  ) {}

  async currencyExists(code: string): Promise<boolean> {
    // `currencies` es un catálogo global (sin RLS).
    const found = await this.prisma.currency.findUnique({
      where: { code },
      select: { code: true },
    });
    return found !== null;
  }

  async stored(
    date: string,
    currencies: readonly string[],
  ): Promise<StoredDayRates | null> {
    const read = await this.rates.stored(date, { currencies });
    return read
      ? { source: read.source, rates: read.rates, rateDate: read.rateDate }
      : null;
  }
}
