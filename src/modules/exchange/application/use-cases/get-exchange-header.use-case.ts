import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  BASE_CURRENCY,
  type ExchangeRateSource,
} from '../../domain/exchange-rate-source';
import { headerCurrencies, perReference } from '../../domain/clinic-currencies';
import { BCV_CURRENCIES } from '../../domain/bcv-rate';
import {
  CLINIC_CURRENCIES_REPOSITORY,
  type ClinicCurrenciesRepository,
} from '../../domain/ports/clinic-currencies-repository.port';
import {
  CLINIC_CURRENCY_TEXTS_REPOSITORY,
  type ClinicCurrencyTextsRepository,
} from '../../domain/ports/clinic-currency-texts-repository.port';
import {
  CLINIC_EXCHANGE_SETTINGS_REPOSITORY,
  type ClinicExchangeSettingsRepository,
} from '../../domain/ports/clinic-exchange-settings-repository.port';
import {
  EXCHANGE_RATE_REPOSITORY,
  type ExchangeRateRepository,
} from '../../domain/ports/exchange-rate-repository.port';
import { ExchangeRateUnavailableError } from '../../domain/ports/exchange-rate-provider.port';
import {
  GetRatesForDateUseCase,
  type RatesForDate,
} from './get-rates-for-date.use-case';
import { EXCHANGE_RATE_CLOCK } from './manual-exchange-rates.use-cases';

/** Una fila del indicador: «1 {currency} = {perReference} {reference}». */
export interface ExchangeHeaderRate {
  currency: string;
  /** Unidades de la moneda de referencia por 1 de `currency`; null = sin tasa. */
  perReference: number | null;
  /** Texto propio de `currency` (DX-517, p. ej. «$»); null = el código ISO. */
  label: string | null;
  /** De dónde sale la tasa (la fuente de la clínica para ese día). */
  source: ExchangeRateSource;
  /** Día civil de la tasa (AAAA-MM-DD): hoy en la sede o, con MANUAL y el plazo de DX-384, uno anterior. */
  date: string;
  /**
   * AUTOMATIC: cuándo se guardó la tasa del proveedor (ISO 8601). BCV: la de
   * la fila del BCV (o la del proveedor si la fila no usa VES ni EUR). MANUAL
   * o sin tasa: null.
   */
  fetchedAt: string | null;
  /**
   * DX-585: con BCV, la «Fecha Valor» de la tasa del BCV que usa la fila (si
   * la moneda o la referencia es VES o EUR). Si no, null.
   */
  valueDate: string | null;
}

export interface ExchangeHeader {
  /** ¿Enseña el menú el indicador? */
  visible: boolean;
  /** Moneda de referencia (la de la clínica o la de la sede activa); null = ninguna. */
  reference: string | null;
  /** Texto propio de la de referencia (DX-517, p. ej. «Bs.»); null = el código ISO. */
  referenceLabel: string | null;
  rates: ExchangeHeaderRate[];
  /**
   * Monedas en que la clínica acepta cobros, en su orden (vacía = cualquiera).
   * Para filtrar el selector de moneda del cobro con cualquier rol: el ajuste
   * completo (GET /exchange/settings) es solo ADMIN. Va siempre, también
   * con el indicador oculto.
   */
  acceptedCurrencies: string[];
  /** Cuándo se calculó esta respuesta (ISO 8601). */
  updatedAt: string;
}

/**
 * DX-584: la tasa que enseña el menú de la sede activa: cada moneda aceptada
 * distinta de la de referencia, con «1 {moneda} = N {referencia}» cruzado vía
 * USD con las tasas del día de la sede. Lee las tasas por el mismo camino que
 * `GET /exchange/rates` (`forRequest`): la fuente de la clínica (AUTOMATIC o
 * MANUAL con el plazo de DX-384) y, con AUTOMATIC, la caché del proveedor y
 * sus presupuestos (SEC-054): nunca gasta más cupo que esa ruta. Si el
 * proveedor no da la tasa (caído, caché negativa o presupuesto agotado), las
 * filas salen con `perReference: null` en vez de un error: el menú dice «Sin
 * tasa hoy». Con el indicador apagado no lee ninguna tasa.
 *
 * DX-585: con fuente BCV, `source` es BCV en todas las filas (la fuente de la
 * clínica, la que congela un abono) y las que usan VES o EUR llevan la
 * «Fecha Valor» y la hora de consulta de la tasa del BCV.
 */
@Injectable()
export class GetExchangeHeaderUseCase {
  constructor(
    @Inject(CLINIC_CURRENCIES_REPOSITORY)
    private readonly currencies: ClinicCurrenciesRepository,
    @Inject(CLINIC_CURRENCY_TEXTS_REPOSITORY)
    private readonly texts: ClinicCurrencyTextsRepository,
    @Inject(CLINIC_EXCHANGE_SETTINGS_REPOSITORY)
    private readonly settings: ClinicExchangeSettingsRepository,
    @Inject(EXCHANGE_RATE_REPOSITORY)
    private readonly snapshots: ExchangeRateRepository,
    private readonly rates: GetRatesForDateUseCase,
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date,
  ) {}

  async execute(): Promise<ExchangeHeader> {
    const now = this.now();
    const updatedAt = now.toISOString();
    const [clinic, location] = await Promise.all([
      this.currencies.get(),
      this.currencies.headerLocation(),
    ]);
    const reference =
      clinic.rateReferenceCurrency ?? location?.currency ?? null;
    const hidden = (): ExchangeHeader => ({
      visible: false,
      reference,
      referenceLabel: null,
      rates: [],
      acceptedCurrencies: clinic.acceptedCurrencies,
      updatedAt,
    });
    if (clinic.showRateInHeader === false || !location || !reference) {
      return hidden();
    }
    const shown = headerCurrencies(clinic, reference);
    if (shown.length === 0) return hidden();

    const today = civilDateIn(now, location.timeZone);
    const wanted = [...new Set([...shown, reference])].filter(
      (c) => c !== BASE_CURRENCY,
    );
    const [texts, read] = await Promise.all([
      this.texts.get(),
      this.readRates(today, wanted),
    ]);
    const source = read?.source ?? (await this.settings.get()).source;
    const date = read?.rateDate ?? today;
    const fetchedAt = await this.fetchedAt(read, wanted);
    // DX-585: una fila «del BCV» es la que usa VES o EUR con fuente BCV.
    const bcv = read?.source === 'BCV' ? (read.bcv ?? null) : null;
    const bcvOf = (currency: string) =>
      BCV_CURRENCIES.includes(currency) || BCV_CURRENCIES.includes(reference)
        ? bcv
        : null;
    return {
      visible: true,
      reference,
      referenceLabel: texts[reference] ?? null,
      rates: shown.map((currency) => {
        const value = read
          ? perReference(read.rates, currency, reference)
          : null;
        return {
          currency,
          perReference: value,
          label: texts[currency] ?? null,
          source,
          date,
          fetchedAt:
            value === null ? null : (bcvOf(currency)?.fetchedAt ?? fetchedAt),
          valueDate:
            value === null ? null : (bcvOf(currency)?.valueDate ?? null),
        };
      }),
      acceptedCurrencies: clinic.acceptedCurrencies,
      updatedAt,
    };
  }

  /** Las tasas del día; null si el proveedor no las da ahora mismo. */
  private async readRates(
    today: string,
    currencies: string[],
  ): Promise<RatesForDate | null> {
    try {
      return await this.rates.forRequest(today, { currencies });
    } catch (error) {
      // Proveedor caído, caché negativa o presupuesto agotado (SEC-054), o un
      // día fuera de la ventana de la clínica: el indicador dice «sin tasa».
      if (
        error instanceof ExchangeRateUnavailableError ||
        error instanceof BadRequestException
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Con AUTOMATIC (y BCV, para las monedas que no son del BCV), el momento
   * en que se guardó la tasa del proveedor de ese día (el más reciente de las
   * monedas del indicador); con MANUAL, null.
   */
  private async fetchedAt(
    read: RatesForDate | null,
    currencies: string[],
  ): Promise<string | null> {
    if (!read || read.source === 'MANUAL') return null;
    // DX-585: con BCV, VES y EUR no salen de la caché del proveedor.
    const fromProvider =
      read.source === 'BCV'
        ? currencies.filter((c) => !BCV_CURRENCIES.includes(c))
        : currencies;
    if (fromProvider.length === 0) return null;
    const rows = await this.snapshots.findByDate(read.rateDate);
    const times = rows
      .filter((r) => fromProvider.includes(r.currency))
      .map((r) => r.fetchedAt.getTime());
    return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
  }
}
