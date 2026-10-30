import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { EXCHANGE_RATE_REPOSITORY } from '../../domain/ports/exchange-rate-repository.port';
import type { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import {
  EXCHANGE_RATE_PROVIDER,
  ExchangeRateUnavailableError,
} from '../../domain/ports/exchange-rate-provider.port';
import type { ExchangeRateProvider } from '../../domain/ports/exchange-rate-provider.port';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';
import {
  CLINIC_EXCHANGE_SETTINGS_REPOSITORY,
  type ClinicExchangeSettings,
  type ClinicExchangeSettingsRepository,
} from '../../domain/ports/clinic-exchange-settings-repository.port';
import {
  MANUAL_EXCHANGE_RATE_REPOSITORY,
  type ManualExchangeRateRepository,
} from '../../domain/ports/manual-exchange-rate-repository.port';
import type { ExchangeRateSource } from '../../domain/exchange-rate-source';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { civilDateIn, parseCivilDate } from '../../../../shared/time/civil-day';
import {
  DEFAULT_PROVIDER_RATES_LIMITS,
  ProviderRatesGate,
  type ProviderRatesCaller,
} from '../provider-rates-gate';
import { EXCHANGE_RATE_CLOCK } from './manual-exchange-rates.use-cases';

/**
 * Un día civil YYYY-MM-DD que EXISTE (`2026-02-30` y `2026-13-01` no; BE-049).
 * Guarda la fecha antes de que llegue a la consulta del repositorio o (en un
 * fallo de caché) a la URL del proveedor.
 */
export function isValidRateDate(date: unknown): date is string {
  return typeof date === 'string' && parseCivilDate(date) !== null;
}

export const RATE_DATE_INVALID_MESSAGE =
  'date debe ser un día que exista, con el formato AAAA-MM-DD.';

/** 400 de una fecha de tasa que no es un día real. */
export function invalidRateDate(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'EXCHANGE_RATE_DATE_INVALID',
    message: RATE_DATE_INVALID_MESSAGE,
  });
}

/**
 * SEC-054: 400 de un día fuera de lo que una clínica puede pedir al
 * proveedor (antes de su alta y de su primer abono, o después de hoy).
 */
function rateDateOutOfRange(first: string, today: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'EXCHANGE_RATE_DATE_OUT_OF_RANGE',
    message: `No hay tasa guardada de ese día y solo se piden al proveedor los días entre el ${first} (alta de la clínica o su primer abono) y hoy, ${today}.`,
    first,
    today,
  });
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

/** Las tasas de un día; `memoized()` devuelve una que cachea por día. */
export type RatesLookup = (date: string) => Promise<RatesForDate>;

/**
 * Antes de llamar al proveedor por un día que no está en caché: lanza si ese
 * día no se le puede pedir (SEC-054, solo las rutas de tasas).
 */
type BeforeProviderCall = (date: string) => Promise<void>;

/**
 * Tasas de un día para la clínica del contexto (DX-374):
 * - fuente MANUAL y día >= `manualSince`: las tasas que la clínica registró
 *   para ESE día. Una moneda sin tasa no aparece y nunca se pide al proveedor
 *   ni se toma la de otro día;
 * - fuente MANUAL y un día anterior al paso a MANUAL: la tasa automática,
 *   pero solo la ya guardada (SEC-054: una clínica en MANUAL nunca llama al
 *   proveedor); sin ella, «sin tasa»;
 * - AUTOMATIC o sin clínica en el contexto: cache-then-fetch del proveedor
 *   (ver `providerRates`), a través de `ProviderRatesGate` (caché negativa,
 *   single-flight y presupuestos).
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
    @Optional()
    private readonly gate: ProviderRatesGate = new ProviderRatesGate(
      DEFAULT_PROVIDER_RATES_LIMITS,
      () => new Date(),
    ),
    @Optional()
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** La lectura de quien convierte por dentro (saldos, abonos, barridos). */
  execute(date: string): Promise<RatesForDate> {
    return this.ratesWith(date, () => this.clinicSettings());
  }

  /**
   * SEC-054: la lectura de las rutas `GET /exchange/rates` y `/convert`. Un
   * día ya guardado se sirve siempre; uno sin guardar solo se pide al
   * proveedor si está entre el alta de la clínica (o su primer abono, lo
   * anterior) y hoy en la zona de sus sedes (la más adelantada): fuera de
   * ahí, 400 sin llamar a nadie.
   */
  forRequest(date: string): Promise<RatesForDate> {
    return this.ratesWith(
      date,
      () => this.clinicSettings(),
      (day) => this.assertWithinProviderWindow(day),
    );
  }

  /**
   * Una lectura que cachea, para UN caso de uso de UNA clínica (saldo,
   * totales): los ajustes se leen una vez y cada día una vez, en vez de una
   * lectura de `tenants` y una transacción por abono. Mismo resultado que
   * `execute` (un fallo de un día también se repite para ese día).
   */
  memoized(): RatesLookup {
    let settings: Promise<ClinicExchangeSettings | null> | undefined;
    const byDate = new Map<string, Promise<RatesForDate>>();
    const clinicSettings = () => (settings ??= this.clinicSettings());
    return (date) => {
      let rates = byDate.get(date);
      if (!rates) {
        rates = this.ratesWith(date, clinicSettings);
        byDate.set(date, rates);
      }
      return rates;
    };
  }

  private clinicSettings(): Promise<ClinicExchangeSettings | null> {
    return this.tenantContext.getTenantId() === undefined
      ? Promise.resolve(null)
      : this.settings.get();
  }

  private async ratesWith(
    date: string,
    clinicSettings: () => Promise<ClinicExchangeSettings | null>,
    beforeProviderCall?: BeforeProviderCall,
  ): Promise<RatesForDate> {
    if (!isValidRateDate(date)) throw invalidRateDate();
    const settings = await clinicSettings();
    if (settings?.source === 'MANUAL') {
      if (settings.manualSince === null || date >= settings.manualSince) {
        return {
          base: 'USD',
          source: 'MANUAL',
          rates: await this.manual.ratesOn(date),
        };
      }
      return {
        base: 'USD',
        source: 'AUTOMATIC',
        rates: await this.storedRates(date),
      };
    }
    return {
      base: 'USD',
      source: 'AUTOMATIC',
      rates: await this.cachedOrFetched(
        date,
        this.callerInContext(),
        beforeProviderCall,
      ),
    };
  }

  private callerInContext(): ProviderRatesCaller {
    const tenantId = this.tenantContext.getTenantId();
    return tenantId === undefined
      ? { kind: 'PLATFORM' }
      : { kind: 'CLINIC', tenantId };
  }

  /** Solo el snapshot guardado: nunca el proveedor. */
  private async storedRates(date: string): Promise<Record<string, number>> {
    const cached = await this.repo.findByDate(date);
    if (cached.length === 0) {
      throw new ExchangeRateUnavailableError(
        `Sin tasas guardadas del ${date} y la clínica usa tasa manual: no se piden al proveedor`,
      );
    }
    return toRatesRecord(cached);
  }

  private async assertWithinProviderWindow(date: string): Promise<void> {
    const { since, timeZones } = await this.settings.providerWindow();
    const zones = timeZones.length > 0 ? timeZones : ['UTC'];
    const now = this.now();
    const first = zones.map((zone) => civilDateIn(since, zone)).sort()[0];
    const today = zones
      .map((zone) => civilDateIn(now, zone))
      .sort()
      .at(-1)!;
    if (date < first || date > today) {
      throw rateDateOutOfRange(first, today);
    }
  }

  /**
   * Cache-then-fetch: reads the day's rates from the DB snapshot first; only
   * calls the external provider (and persists the result) on a cache miss.
   * Re-invoking for the same date after a miss is a hit — no duplicate fetch,
   * no duplicate rows (repo.upsertMany is idempotent on `@@unique([date,
   * currency])`). No mira la fuente de ninguna clínica; el fallo de caché
   * cuenta en el presupuesto de la clínica del contexto (SEC-054).
   */
  providerRates(date: string): Promise<Record<string, number>> {
    if (!isValidRateDate(date)) return Promise.reject(invalidRateDate());
    return this.cachedOrFetched(date, this.callerInContext());
  }

  /**
   * La de la precarga diaria (DX-085): igual que `providerRates`, pero fuera
   * de los presupuestos y sin leer la caché negativa (SEC-054): las
   * peticiones de los usuarios nunca la dejan sin cupo.
   */
  prefetchProviderRates(date: string): Promise<Record<string, number>> {
    if (!isValidRateDate(date)) return Promise.reject(invalidRateDate());
    return this.cachedOrFetched(date, { kind: 'PREFETCH' });
  }

  private async cachedOrFetched(
    date: string,
    caller: ProviderRatesCaller,
    beforeProviderCall?: BeforeProviderCall,
  ): Promise<Record<string, number>> {
    const cached = await this.repo.findByDate(date);
    if (cached.length > 0) {
      return toRatesRecord(cached);
    }
    await beforeProviderCall?.(date);
    return this.gate.fetch(date, caller, async () => {
      // Otra petición pudo guardarlo entre la lectura de arriba y esta.
      const stored = await this.repo.findByDate(date);
      if (stored.length > 0) return toRatesRecord(stored);
      const fetched = await this.provider.fetchRates(date);
      await this.repo.upsertMany(date, fetched.rates);
      return fetched.rates;
    });
  }
}
