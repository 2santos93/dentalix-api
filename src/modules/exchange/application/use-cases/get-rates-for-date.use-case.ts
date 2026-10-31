import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { EXCHANGE_RATE_REPOSITORY } from '../../domain/ports/exchange-rate-repository.port';
import type { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import { EXCHANGE_RATE_PROVIDER } from '../../domain/ports/exchange-rate-provider.port';
import type { ExchangeRateProvider } from '../../domain/ports/exchange-rate-provider.port';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';
import {
  CLINIC_EXCHANGE_SETTINGS_REPOSITORY,
  type ClinicExchangeSettings,
  type ClinicExchangeSettingsRepository,
  type ClinicProviderWindow,
} from '../../domain/ports/clinic-exchange-settings-repository.port';
import {
  MANUAL_EXCHANGE_RATE_REPOSITORY,
  type ManualExchangeRateRepository,
} from '../../domain/ports/manual-exchange-rate-repository.port';
import type { ExchangeRateSource } from '../../domain/exchange-rate-source';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  civilDateIn,
  parseCivilDate,
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import {
  DEFAULT_PROVIDER_RATES_LIMITS,
  ProviderRatesGate,
  type ProviderRatesCaller,
} from '../provider-rates-gate';
import { ProviderRatesCallerScope } from '../provider-rates-caller-scope';
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
 * La zona IANA más atrasada (UTC−12): su día civil es el «hoy» más antiguo
 * del planeta, así que un día que no lo supera no es futuro en ninguna sede.
 */
const EARLIEST_TIME_ZONE = 'Etc/GMT+12';

/**
 * BE-049 (DX-383): las rutas de tasas solo admiten días del rango de las
 * fechas de consulta (`PERIOD_DAY_MIN`..`PERIOD_DAY_MAX`, el mismo del alta de
 * una tasa manual). Fuera de él no hay tasa que tenga sentido para una
 * clínica, y con AUTOMATIC cada día nuevo sería una llamada al proveedor.
 */
export function isRateDateInRange(date: string): boolean {
  return date >= PERIOD_DAY_MIN && date <= PERIOD_DAY_MAX;
}

export const RATE_DATE_OUT_OF_RANGE_MESSAGE = `date tiene que ser un día entre el ${PERIOD_DAY_MIN} y el ${PERIOD_DAY_MAX}.`;

/** 400 de una fecha de tasa fuera de `PERIOD_DAY_MIN`..`PERIOD_DAY_MAX`. */
function rateDateNotInRange(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'EXCHANGE_RATE_DATE_INVALID',
    message: RATE_DATE_OUT_OF_RANGE_MESSAGE,
  });
}

/**
 * BE-049 (DX-383): 400 de un día que aún no ha llegado en ninguna sede de la
 * clínica: no tiene tasa (ni manual ni del proveedor) que dar.
 */
function rateDateInFuture(today: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'EXCHANGE_RATE_DATE_FUTURE',
    message: `Ese día aún no ha llegado en las sedes de la clínica: no tiene tasa. Hoy es ${today}.`,
    today,
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
  /**
   * DX-402: estas son las tasas manuales de un día ANTERIOR a `manualSince`
   * que no tiene tasa del proveedor guardada: la tasa de respaldo de los
   * abonos pendientes de ese día. Solo en la lectura que lo pide
   * (`memoized({ manualBackup: true })`).
   */
  backup?: { manualSince: string };
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
 * Las tasas de un día; `memoized()` devuelve una que cachea por día.
 * `noBackup`: en una lectura con tasa de respaldo (DX-402), el camino
 * automático de ese día (si la de respaldo no cubre las dos monedas).
 */
export type RatesLookup = (
  date: string,
  options?: { noBackup?: boolean },
) => Promise<RatesForDate>;

/** DX-402: la lectura del reintento de los abonos sin tasa. */
export interface RatesLookupOptions {
  /**
   * Con MANUAL, un día anterior a `manualSince` sin tasa del proveedor
   * guardada usa la tasa manual registrada para ese día, si la hay, como
   * tasa de respaldo (sin llamar al proveedor).
   */
  manualBackup?: boolean;
}

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
 * - cualquier otro caso (AUTOMATIC, un día anterior al paso a MANUAL o sin
 *   clínica en el contexto): cache-then-fetch del proveedor (ver
 *   `providerRates`), a través de `ProviderRatesGate` (caché negativa,
 *   single-flight y presupuestos; SEC-054). Un día anterior al paso a MANUAL
 *   sigue pidiéndose si falta: si no, un abono de ese día que quedó «sin
 *   tasa» al cambiar (BE-047) no la congelaría nunca en el barrido.
 *
 * DX-402: la lectura del reintento de los abonos sin tasa
 * (`memoized({ manualBackup: true })`) añade la tasa de respaldo: con MANUAL,
 * un día anterior a `manualSince` sin tasa del proveedor guardada usa la tasa
 * manual que la clínica registró para ESE día, si la hay, sin llamar al
 * proveedor. Así el abono que quedó «sin tasa» con la automática se resuelve
 * cuando la clínica pasa a manual y registra la de su día. Nunca cambia una
 * tasa ya congelada: solo la leen los abonos que aún la esperan.
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
    @Optional()
    private readonly callerScope: ProviderRatesCallerScope = new ProviderRatesCallerScope(),
  ) {}

  /** La lectura de quien convierte por dentro (saldos, abonos, barridos). */
  execute(date: string): Promise<RatesForDate> {
    return this.ratesWith(date, () => this.clinicSettings());
  }

  /**
   * SEC-054: la lectura de las rutas `GET /exchange/rates` y `/convert`.
   * BE-049 (DX-383): con las dos fuentes, el día tiene que existir, caer en
   * `PERIOD_DAY_MIN`..`PERIOD_DAY_MAX` y no ser posterior a hoy en la zona de
   * las sedes (la más adelantada); si no, 400 sin leer tasas ni llamar a
   * nadie. Un día ya guardado se sirve siempre; uno sin guardar solo se pide
   * al proveedor si además no es anterior al alta de la clínica (o a su
   * primer abono, lo anterior).
   */
  async forRequest(date: string): Promise<RatesForDate> {
    if (!isValidRateDate(date)) throw invalidRateDate();
    if (!isRateDateInRange(date)) throw rateDateNotInRange();
    // La ventana (alta, primer abono, zonas de las sedes) son tres consultas:
    // se lee como mucho una vez, y solo si hace falta. Un día que ya llegó en
    // la zona más atrasada del planeta no es futuro en ninguna sede.
    let window: Promise<ClinicProviderWindow> | undefined;
    const readWindow = () => (window ??= this.settings.providerWindow());
    if (date > civilDateIn(this.now(), EARLIEST_TIME_ZONE)) {
      const { today } = this.windowDays(await readWindow());
      if (date > today) throw rateDateInFuture(today);
    }
    return this.ratesWith(
      date,
      () => this.clinicSettings(),
      async (day) => this.assertWithinProviderWindow(day, await readWindow()),
    );
  }

  /**
   * Una lectura que cachea, para UN caso de uso de UNA clínica (saldo,
   * totales): los ajustes se leen una vez y cada día una vez, en vez de una
   * lectura de `tenants` y una transacción por abono. Mismo resultado que
   * `execute` (un fallo de un día también se repite para ese día).
   */
  memoized(options: RatesLookupOptions = {}): RatesLookup {
    let settings: Promise<ClinicExchangeSettings | null> | undefined;
    const byDate = new Map<string, Promise<RatesForDate>>();
    const clinicSettings = () => (settings ??= this.clinicSettings());
    return (date, lookup = {}) => {
      const manualBackup = options.manualBackup === true && !lookup.noBackup;
      const key = `${date}|${manualBackup}`;
      let rates = byDate.get(key);
      if (!rates) {
        rates = this.ratesWith(date, clinicSettings, undefined, manualBackup);
        byDate.set(key, rates);
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
    manualBackup = false,
  ): Promise<RatesForDate> {
    if (!isValidRateDate(date)) throw invalidRateDate();
    const settings = await clinicSettings();
    if (
      settings?.source === 'MANUAL' &&
      (settings.manualSince === null || date >= settings.manualSince)
    ) {
      return {
        base: 'USD',
        source: 'MANUAL',
        rates: await this.manual.ratesOn(date),
      };
    }
    if (manualBackup && settings?.source === 'MANUAL' && settings.manualSince) {
      const backup = await this.backupRates(date, settings.manualSince);
      if (backup) return backup;
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

  /**
   * DX-402: la tasa de respaldo de un día anterior a `manualSince`: las
   * manuales de ese día, solo si el proveedor no tiene tasa guardada de él
   * (si la tiene, manda la automática, como en cualquier otro abono de ese
   * día). `null`: no hay respaldo y sigue el camino automático.
   */
  private async backupRates(
    date: string,
    manualSince: string,
  ): Promise<RatesForDate | null> {
    const cached = await this.repo.findByDate(date);
    if (cached.length > 0) {
      return { base: 'USD', source: 'AUTOMATIC', rates: toRatesRecord(cached) };
    }
    const rates = await this.manual.ratesOn(date);
    if (Object.keys(rates).length === 0) return null;
    return { base: 'USD', source: 'MANUAL', rates, backup: { manualSince } };
  }

  /** SEC-058: dentro del barrido de reintentos, gasta de su cupo reservado. */
  private callerInContext(): ProviderRatesCaller {
    const tenantId = this.tenantContext.getTenantId();
    if (tenantId === undefined) return { kind: 'PLATFORM' };
    return this.callerScope.isSweep()
      ? { kind: 'SWEEP', tenantId }
      : { kind: 'CLINIC', tenantId };
  }

  /**
   * Primer día de la ventana (en la sede más atrasada) y hoy (en la más
   * adelantada): así ninguna sede queda sin su primer día ni sin su hoy.
   */
  private windowDays({ since, timeZones }: ClinicProviderWindow): {
    first: string;
    today: string;
  } {
    const zones = timeZones.length > 0 ? timeZones : ['UTC'];
    const now = this.now();
    return {
      first: zones.map((zone) => civilDateIn(since, zone)).sort()[0],
      today: zones
        .map((zone) => civilDateIn(now, zone))
        .sort()
        .at(-1)!,
    };
  }

  private assertWithinProviderWindow(
    date: string,
    window: ClinicProviderWindow,
  ): Promise<void> {
    const { first, today } = this.windowDays(window);
    if (date < first || date > today) {
      return Promise.reject(rateDateOutOfRange(first, today));
    }
    return Promise.resolve();
  }

  /**
   * Cache-then-fetch: reads the day's rates from the DB snapshot first; only
   * calls the external provider (and persists the result) on a cache miss.
   * Re-invoking for the same date after a miss is a hit — no duplicate fetch,
   * no duplicate rows (repo.upsertMany is idempotent on `@@unique([date,
   * currency])`). No mira la fuente de ninguna clínica; el fallo de caché
   * cuenta en el presupuesto de la clínica del contexto (SEC-054), o en el
   * de su barrido de reintentos (SEC-058).
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
