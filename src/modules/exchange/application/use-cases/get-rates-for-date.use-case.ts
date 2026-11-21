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
  type ManualRateInForce,
} from '../../domain/ports/manual-exchange-rate-repository.port';
import type { ManualExchangeRate } from '../../domain/entities/manual-exchange-rate.entity';
import {
  BASE_CURRENCY,
  type ExchangeRateSource,
} from '../../domain/exchange-rate-source';
import {
  selectManualRatesForPair,
  windowStart,
} from '../../domain/manual-rate-fallback';
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
import {
  BCV_CURRENCIES,
  bcvOldestValueDate,
  bcvRatesPerUsd,
} from '../../domain/bcv-rate';
import {
  BCV_RATE_REPOSITORY,
  type BcvRateRepository,
} from '../../domain/ports/bcv-rate-repository.port';

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
   * DX-384: día civil de estas tasas. Es el pedido salvo con MANUAL cuando
   * se pidieron monedas (`currencies`) y no estaban registradas ese día: la
   * última fecha anterior, dentro del plazo de la clínica, en que estaban
   * todas (una sola fecha para todas).
   */
  rateDate: string;
  /**
   * DX-402: estas son las tasas manuales de un día ANTERIOR a `manualSince`
   * que no tiene tasa del proveedor guardada: la tasa de respaldo de los
   * abonos pendientes de ese día. Solo en la lectura que lo pide
   * (`memoized({ manualBackup: true })`).
   */
  backup?: { manualSince: string };
  /**
   * DX-585: solo con fuente BCV. La tasa del BCV que rige ese día (la de
   * fecha valor <= el día más reciente, como mucho `BCV_MAX_AGE_DAYS` atrás)
   * y de la que salen VES y EUR; `null` si no hay ninguna (VES y EUR quedan
   * «sin tasa»).
   */
  bcv?: BcvRateInfo | null;
  /**
   * DX-586: solo con tasas manuales (fuente MANUAL o la de respaldo de
   * DX-402). Las que rigen en `rates`: por moneda, la de mayor
   * `effectiveFrom` ≤ el instante pedido (ahora, por defecto) del día
   * `rateDate`. Con ellas el abono guarda su referencia (`MANUAL:<id>`).
   */
  manualRates?: ManualRateUsed[];
}

/** DX-586: una tasa manual que rige, con su id y desde cuándo. */
export interface ManualRateUsed {
  id: string;
  currency: string;
  rate: number;
  /** Día civil de la tasa (AAAA-MM-DD). */
  date: string;
  /** Desde qué instante rige (ISO 8601). */
  effectiveFrom: string;
}

/** DX-585: de qué publicación del BCV salen VES y EUR. */
export interface BcvRateInfo {
  /** «Fecha Valor» de la tasa (AAAA-MM-DD), nunca posterior al día pedido. */
  valueDate: string;
  /** Cuándo se consultó (ISO 8601). */
  fetchedAt: string;
}

/** DX-586: las tasas manuales de un día que rigen, con sus ids. */
function manualRead(
  date: string,
  inForce: Record<string, ManualRateInForce>,
): RatesForDate {
  const rates: Record<string, number> = {};
  const manualRates: ManualRateUsed[] = [];
  for (const [currency, entry] of Object.entries(inForce)) {
    rates[currency] = entry.rate;
    manualRates.push({
      id: entry.id,
      currency,
      rate: entry.rate,
      date,
      effectiveFrom: entry.effectiveFrom.toISOString(),
    });
  }
  return { base: 'USD', source: 'MANUAL', rates, rateDate: date, manualRates };
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
  options?: { noBackup?: boolean } & RatesForOptions,
) => Promise<RatesForDate>;

/**
 * DX-384: las monedas (además de USD, que no lleva tasa) para las que se
 * piden las tasas del día. Con MANUAL y plazo > 0, si alguna no está
 * registrada ese día se usa la última fecha anterior, dentro del plazo, en
 * que están todas. Sin ellas, solo las del día exacto.
 */
export interface RatesForOptions {
  currencies?: readonly string[];
  /**
   * DX-586: el instante para el que rigen las tasas manuales (la de mayor
   * `effectiveFrom` ≤ él dentro del día). Por defecto, ahora: hoy, la
   * vigente; un día pasado, la última de ese día.
   */
  asOf?: Date;
}

/** DX-402: la lectura del reintento de los abonos sin tasa. */
export interface RatesLookupOptions {
  /**
   * Con MANUAL, un día anterior a `manualSince` sin tasa del proveedor
   * guardada usa la tasa manual registrada para ese día, si la hay, como
   * tasa de respaldo (sin llamar al proveedor).
   */
  manualBackup?: boolean;
}

/** DX-569: `stored` corta antes de llamar al proveedor. */
class NotStoredRatesError extends Error {}

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
    @Optional()
    @Inject(BCV_RATE_REPOSITORY)
    private readonly bcv: BcvRateRepository | null = null,
  ) {}

  /** La lectura de quien convierte por dentro (saldos, abonos, barridos). */
  execute(date: string, options: RatesForOptions = {}): Promise<RatesForDate> {
    return this.ratesWith(
      date,
      () => this.clinicSettings(),
      undefined,
      false,
      options.currencies,
      options.asOf,
    );
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
  async forRequest(
    date: string,
    options: RatesForOptions = {},
  ): Promise<RatesForDate> {
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
      false,
      options.currencies,
      options.asOf,
    );
  }

  /**
   * DX-586: todas las tasas manuales registradas para un día (la lista del
   * día que enseña la web junto a las tasas: varias por moneda, cada una
   * desde su hora). Sin clínica en el contexto, vacía.
   */
  manualDay(date: string): Promise<ManualExchangeRate[]> {
    if (this.tenantContext.getTenantId() === undefined) {
      return Promise.resolve([]);
    }
    return this.manual.listDay(date);
  }

  /**
   * DX-586 («Actualizar tasa», fuente AUTOMATIC): vuelve a pedir al proveedor
   * las tasas del día `date` (hoy en la sede) aunque ya estén en caché, y las
   * guarda. Con la ventana y los presupuestos de la clínica (SEC-054): gasta
   * un fallo de caché de su presupuesto, como pedir un día sin guardar.
   */
  async refreshProviderRates(date: string): Promise<Record<string, number>> {
    if (!isValidRateDate(date)) throw invalidRateDate();
    await this.assertWithinProviderWindow(
      date,
      await this.settings.providerWindow(),
    );
    return this.gate.fetch(date, this.callerInContext(), async () => {
      const fetched = await this.provider.fetchRates(date);
      await this.repo.upsertMany(date, fetched.rates);
      return fetched.rates;
    });
  }

  /**
   * DX-569: las tasas de un día que la clínica YA tiene guardadas, sin pedir
   * nada al proveedor: con MANUAL, las registradas (como el cobro de ese
   * día); con AUTOMATIC, las de la caché del proveedor si ese día ya se pidió.
   * `null` si no hay ninguna guardada. Es la lectura de una ruta pública (el
   * enlace de pago): nunca puede gastar el presupuesto del proveedor.
   */
  stored(
    date: string,
    options: RatesForOptions = {},
  ): Promise<RatesForDate | null> {
    return this.storedWith(date, () => this.clinicSettings(), options);
  }

  /**
   * DX-567: `stored()` para muchas lecturas de UNA petición (un informe que
   * convierte día a día): los ajustes de la clínica se leen una sola vez.
   * Igual que `stored()`, nunca llama al proveedor.
   */
  storedReader(): (
    date: string,
    options?: RatesForOptions,
  ) => Promise<RatesForDate | null> {
    let settings: Promise<ClinicExchangeSettings | null> | undefined;
    const clinicSettings = () => (settings ??= this.clinicSettings());
    return (date, options = {}) =>
      this.storedWith(date, clinicSettings, options);
  }

  private async storedWith(
    date: string,
    clinicSettings: () => Promise<ClinicExchangeSettings | null>,
    options: RatesForOptions,
  ): Promise<RatesForDate | null> {
    try {
      return await this.ratesWith(
        date,
        clinicSettings,
        () => Promise.reject(new NotStoredRatesError()),
        false,
        options.currencies,
        options.asOf,
      );
    } catch (error) {
      if (error instanceof NotStoredRatesError) return null;
      throw error;
    }
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
      const currencies = lookup.currencies;
      const asOf = lookup.asOf;
      const key = `${date}|${manualBackup}|${[...new Set(currencies ?? [])].sort().join(',')}|${asOf?.toISOString() ?? ''}`;
      let rates = byDate.get(key);
      if (!rates) {
        rates = this.ratesWith(
          date,
          clinicSettings,
          undefined,
          manualBackup,
          currencies,
          asOf,
        );
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
    currencies?: readonly string[],
    asOf?: Date,
  ): Promise<RatesForDate> {
    if (!isValidRateDate(date)) throw invalidRateDate();
    const settings = await clinicSettings();
    if (
      settings?.source === 'MANUAL' &&
      (settings.manualSince === null || date >= settings.manualSince)
    ) {
      return this.manualRates(
        date,
        settings.manualRateMaxAgeDays,
        settings.manualSince,
        currencies,
        asOf ?? this.now(),
      );
    }
    if (settings?.source === 'BCV') {
      return this.bcvRates(date, beforeProviderCall, currencies);
    }
    if (manualBackup && settings?.source === 'MANUAL' && settings.manualSince) {
      const backup = await this.backupRates(
        date,
        settings.manualSince,
        asOf ?? this.now(),
      );
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
      rateDate: date,
    };
  }

  /**
   * DX-384: las tasas manuales del día. Con `currencies` y plazo > 0, si
   * alguna no está registrada ese día, las de la última fecha anterior dentro
   * del plazo (días civiles de la sede del abono) que las tiene todas; si no
   * hay ninguna, las del día tal cual, y quien convierte ve la moneda ausente
   * como «sin tasa» (nunca 1:1). Una tasa posterior al día no se usa.
   */
  private async manualRates(
    date: string,
    maxAgeDays: number,
    manualSince: string | null,
    currencies: readonly string[] | undefined,
    asOf: Date,
  ): Promise<RatesForDate> {
    const exact = await this.manual.ratesOn(date, asOf);
    const wanted = (currencies ?? []).filter((c) => c !== BASE_CURRENCY);
    const complete = wanted.every((c) => exact[c] !== undefined);
    if (maxAgeDays > 0 && wanted.length > 0 && !complete) {
      const fallback = selectManualRatesForPair(
        date,
        maxAgeDays,
        wanted,
        await this.manual.ratesBetween(
          windowStart(date, maxAgeDays, manualSince),
          date,
          wanted,
          asOf,
        ),
        manualSince,
      );
      if (fallback) {
        return {
          base: 'USD',
          source: 'MANUAL',
          rates: fallback.rates,
          rateDate: fallback.rateDate,
          manualRates: Object.entries(fallback.rows).flatMap(
            ([currency, row]) =>
              row.id && row.effectiveFrom
                ? [
                    {
                      id: row.id,
                      currency,
                      rate: row.rate,
                      date: row.date,
                      effectiveFrom: row.effectiveFrom.toISOString(),
                    },
                  ]
                : [],
          ),
        };
      }
    }
    return manualRead(date, exact);
  }

  /**
   * DX-585: con fuente BCV, VES y EUR salen de la tasa del BCV que rige ese
   * día (`bcv_rate_snapshots`: fecha valor <= el día, la más reciente y no
   * más de `BCV_MAX_AGE_DAYS` atrás); el resto de monedas, del proveedor,
   * como AUTOMATIC (caché, ventana y presupuestos SEC-054). Si solo se piden
   * monedas del BCV (o USD), no se llama al proveedor. Sin tasa del BCV, VES
   * y EUR no aparecen («sin tasa»): nunca se toman del proveedor.
   */
  private async bcvRates(
    date: string,
    beforeProviderCall?: BeforeProviderCall,
    currencies?: readonly string[],
  ): Promise<RatesForDate> {
    const wanted = currencies?.filter((c) => c !== BASE_CURRENCY);
    const needsProvider =
      wanted === undefined || wanted.some((c) => !BCV_CURRENCIES.includes(c));
    const [snapshot, provider] = await Promise.all([
      this.bcv?.inForce(date, bcvOldestValueDate(date)) ?? null,
      needsProvider
        ? this.cachedOrFetched(date, this.callerInContext(), beforeProviderCall)
        : Promise.resolve({} as Record<string, number>),
    ]);
    const rates: Record<string, number> = {};
    for (const [currency, rate] of Object.entries(provider)) {
      if (!BCV_CURRENCIES.includes(currency)) rates[currency] = rate;
    }
    if (snapshot) Object.assign(rates, bcvRatesPerUsd(snapshot));
    return {
      base: 'USD',
      source: 'BCV',
      rates,
      rateDate: date,
      bcv: snapshot
        ? {
            valueDate: snapshot.valueDate,
            fetchedAt: snapshot.fetchedAt.toISOString(),
          }
        : null,
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
    asOf: Date,
  ): Promise<RatesForDate | null> {
    const cached = await this.repo.findByDate(date);
    if (cached.length > 0) {
      return {
        base: 'USD',
        source: 'AUTOMATIC',
        rates: toRatesRecord(cached),
        rateDate: date,
      };
    }
    const rates = await this.manual.ratesOn(date, asOf);
    if (Object.keys(rates).length === 0) return null;
    return { ...manualRead(date, rates), backup: { manualSince } };
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
    return this.gate.fetch(
      date,
      caller,
      async () => {
        const fetched = await this.provider.fetchRates(date);
        await this.repo.upsertMany(date, fetched.rates);
        return fetched.rates;
      },
      // Otra petición (u otra réplica) pudo guardarlo entre la lectura de
      // arriba y esta: se mira antes de gastar presupuesto (SEC-058).
      async () => {
        const stored = await this.repo.findByDate(date);
        return stored.length > 0 ? toRatesRecord(stored) : null;
      },
    );
  }
}
