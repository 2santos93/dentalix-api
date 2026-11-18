import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { GetRatesForDateUseCase } from '../../exchange/application/use-cases/get-rates-for-date.use-case';
import type {
  BudgetSecondCurrencySource,
  StoredDayRates,
} from '../application/budget-presentation';

/** Ventana de abonos de la sede con la que se deduce su segunda moneda. */
export const SECOND_CURRENCY_PAYMENTS_WINDOW_DAYS = 90;

/**
 * DX-560: la «segunda moneda de la sede» del enlace de aceptación. La API no
 * guarda una segunda moneda por sede (la web la elige a mano al imprimir), así
 * que se deduce, sin llamar nunca al proveedor de tasas:
 *  1. la moneda de la sede (`locations.currency`) si no es la del plan;
 *  2. si lo es (o la sede no la tiene), la ÚNICA moneda distinta de la del
 *     plan en que la sede registró abonos vivos (sin anular ni borrar) en los
 *     últimos 90 días (una clínica de Caracas que presupuesta en USD y cobra
 *     también en VES → VES);
 *  3. si hay varias o ninguna, sin segunda moneda.
 * La tasa es la que la clínica YA tiene guardada ese día (`stored()`, DX-569).
 */
@Injectable()
export class PrismaBudgetSecondCurrency implements BudgetSecondCurrencySource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: GetRatesForDateUseCase,
  ) {}

  async currencyFor(input: {
    locationId: string;
    locationCurrency: string | null;
    planCurrency: string;
    now: Date;
  }): Promise<string | null> {
    if (
      input.locationCurrency &&
      input.locationCurrency !== input.planCurrency
    ) {
      return input.locationCurrency;
    }
    const since = new Date(
      input.now.getTime() -
        SECOND_CURRENCY_PAYMENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.payment.findMany({
        where: {
          locationId: input.locationId,
          paidAt: { gte: since },
          deletedAt: null,
          voidedAt: null,
          currency: { not: input.planCurrency },
        },
        select: { currency: true },
        distinct: ['currency'],
        take: 2,
      }),
    );
    return rows.length === 1 ? rows[0].currency : null;
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
