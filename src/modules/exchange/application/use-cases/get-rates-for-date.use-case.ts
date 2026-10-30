import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { EXCHANGE_RATE_REPOSITORY } from '../../domain/ports/exchange-rate-repository.port';
import type { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import { EXCHANGE_RATE_PROVIDER } from '../../domain/ports/exchange-rate-provider.port';
import type { ExchangeRateProvider } from '../../domain/ports/exchange-rate-provider.port';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';
import {
  CLINIC_EXCHANGE_SETTINGS_REPOSITORY,
  type ClinicExchangeSettingsRepository,
} from '../../domain/ports/clinic-exchange-settings-repository.port';
import {
  MANUAL_EXCHANGE_RATE_REPOSITORY,
  type ManualExchangeRateRepository,
} from '../../domain/ports/manual-exchange-rate-repository.port';
import type { ExchangeRateSource } from '../../domain/exchange-rate-source';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

// YYYY-MM-DD only. Guards the date before it ever reaches the repository
// query or (on a cache miss) gets interpolated into the provider's URL —
// closes the "unsanitized date" note left from Task 1.
export const DATE_FORMAT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateFormat(date: unknown): date is string {
  return typeof date === 'string' && DATE_FORMAT_PATTERN.test(date);
}

export interface RatesForDate {
  base: 'USD';
  /**
   * DX-374: de dónde salieron estas tasas. Lo devuelve la lectura para que
   * quien convierte pueda guardar también la fuente (DX-375).
   */
  source: ExchangeRateSource;
  /**
   * Unidades de cada moneda por 1 USD. Con MANUAL, solo las monedas con tasa
   * registrada ese día: una moneda ausente está «sin tasa».
   */
  rates: Record<string, number>;
}

function toRatesRecord(
  snapshots: ExchangeRateSnapshot[],
): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const snapshot of snapshots) {
    rates[snapshot.currency] = snapshot.rate;
  }
  return rates;
}

/**
 * Tasas de un día para la clínica del contexto (DX-374):
 * - fuente AUTOMATIC (o sin clínica en el contexto, p. ej. la precarga
 *   diaria): cache-then-fetch del proveedor (ver `providerRates`);
 * - fuente MANUAL: las tasas que la clínica registró para ESE día. Una moneda
 *   sin tasa no aparece y nunca se pide al proveedor ni se toma la de otro
 *   día.
 */
@Injectable()
export class GetRatesForDateUseCase {
  constructor(
    @Inject(EXCHANGE_RATE_REPOSITORY)
    private readonly repo: ExchangeRateRepository,
    @Inject(EXCHANGE_RATE_PROVIDER)
    private readonly provider: ExchangeRateProvider,
    @Inject(CLINIC_EXCHANGE_SETTINGS_REPOSITORY)
    private readonly settings: ClinicExchangeSettingsRepository,
    @Inject(MANUAL_EXCHANGE_RATE_REPOSITORY)
    private readonly manual: ManualExchangeRateRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(date: string): Promise<RatesForDate> {
    if (!isValidDateFormat(date)) {
      throw new BadRequestException('date must match YYYY-MM-DD');
    }
    if (
      this.tenantContext.getTenantId() !== undefined &&
      (await this.settings.getSource()) === 'MANUAL'
    ) {
      return {
        base: 'USD',
        source: 'MANUAL',
        rates: await this.manual.ratesOn(date),
      };
    }
    return {
      base: 'USD',
      source: 'AUTOMATIC',
      rates: await this.providerRates(date),
    };
  }

  /**
   * Cache-then-fetch: reads the day's rates from the DB snapshot first; only
   * calls the external provider (and persists the result) on a cache miss.
   * Re-invoking for the same date after a miss is a hit — no duplicate fetch,
   * no duplicate rows (repo.upsertMany is idempotent on `@@unique([date,
   * currency])`). No mira la fuente de ninguna clínica: es la que usa la
   * precarga diaria.
   */
  async providerRates(date: string): Promise<Record<string, number>> {
    if (!isValidDateFormat(date)) {
      throw new BadRequestException('date must match YYYY-MM-DD');
    }

    const cached = await this.repo.findByDate(date);
    if (cached.length > 0) {
      return toRatesRecord(cached);
    }

    const fetched = await this.provider.fetchRates(date);
    await this.repo.upsertMany(date, fetched.rates);
    return fetched.rates;
  }
}
