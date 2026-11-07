import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import type { RegionalFormat } from '../../../../shared/format/regional-format';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import { GetExchangeRateSettingsUseCase } from '../../../exchange/application/use-cases/exchange-rate-settings.use-cases';
import {
  TREATMENT_PLAN_CLOCK,
  type PlanClock,
} from '../../application/plan-clock';
import {
  lookupReferenceRate,
  referenceRateDay,
} from '../../application/reference-rate-lookup';
import type {
  ReferenceRateLookup,
  ReferenceRateSource,
} from '../../domain/ports/reference-rate-source.port';

/**
 * DX-513-bis: la tasa de la clínica (DX-374) para congelar la referencia de
 * un ítem, del día civil de HOY en la sede de escritura del request (la que
 * sella el descuento, DX-204; un miembro restringido sin sede activa: 403).
 * Usa la misma lectura que los abonos (`ConvertAmountUseCase.quote`).
 */
@Injectable()
export class ClinicReferenceRateSource implements ReferenceRateSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly convert: ConvertAmountUseCase,
    private readonly settings: GetExchangeRateSettingsUseCase,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
  ) {}

  async rateFor(from: string, to: string): Promise<ReferenceRateLookup> {
    const now = this.now();
    const { day: sedeToday, fmt } = await this.writeDay(now);
    const { source } = await this.settings.execute();
    const digits = await this.currencyDigits.table([to]);
    return lookupReferenceRate(
      this.convert,
      {
        from,
        to,
        date: referenceRateDay(source, sedeToday, civilDateIn(now, 'UTC')),
      },
      digits.roundingDigits(to),
      (day) => (fmt ? fmt.civilDate(day) : null),
    );
  }

  /**
   * Día civil de `now` en la zona de la sede de escritura del request, y su
   * formato (locale, DX-315) para el mensaje; sin formato configurado, null
   * (el mensaje no pinta un día ISO).
   */
  private writeDay(
    now: Date,
  ): Promise<{ day: string; fmt: RegionalFormat | null }> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant(async (tx) => {
      const locationId = await this.tenantContext.writeLocationId(tx);
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [locationId]);
      const location = await tx.location.findFirst({
        where: { id: locationId, tenantId },
        select: { id: true, locale: true, hourCycle: true },
      });
      let fmt: RegionalFormat | null = null;
      try {
        fmt = location ? requireLocationFormat(location) : null;
      } catch {
        fmt = null;
      }
      return { day: civilDateIn(now, zoneOf(locationId)), fmt };
    });
  }
}
