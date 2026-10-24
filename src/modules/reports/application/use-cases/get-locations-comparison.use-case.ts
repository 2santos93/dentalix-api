import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import {
  civilDaysInclusive,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import {
  comparisonPeriod,
  type CivilPeriod,
  type CompareMode,
} from '../../domain/comparison-period';
import {
  changeOf,
  combineAggregates,
  computeKpis,
  currenciesOf,
  EMPTY_AGGREGATES,
  KPI_DEFINITIONS,
  KPI_KEYS,
  trendOf,
  type CurrencyValue,
  type KpiDefinition,
  type KpiKey,
  type KpiTrend,
  type KpiValues,
  type PeriodAggregates,
} from '../../domain/kpi-definitions';
import {
  LOCATIONS_COMPARISON_REPOSITORY,
  type ComparisonLocation,
  type LocationsComparisonRepository,
  type PeriodAggregation,
} from '../../domain/ports/locations-comparison-repository.port';

/** Un año (bisiesto incluido), como el informe de descuentos. */
export const LOCATIONS_COMPARISON_MAX_DAYS = 366;

export const INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${LOCATIONS_COMPARISON_MAX_DAYS} días.`;

export const TOTAL_ROW_NAME = 'Total clínica';

export interface LocationsComparisonInput {
  from: string;
  to: string;
  compare: CompareMode;
  currency?: string;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface MetricView {
  value: number | null;
  /** Valor del período de comparación; null sin comparación o sin base. */
  previous: number | null;
  /**
   * Variación frente a `previous` (1 decimal) en la unidad del indicador
   * (`changeUnit`): % relativo, o puntos porcentuales en los porcentajes.
   */
  change: number | null;
  trend: KpiTrend | null;
}

export interface CurrencyMetricView extends MetricView {
  currency: string;
}

export interface ComparisonMetrics {
  production: CurrencyMetricView[];
  collected: CurrencyMetricView[];
  collectionRate: CurrencyMetricView[];
  completedAppointments: MetricView;
  noShowRate: MetricView;
  newPatients: MetricView;
  averageTicket: CurrencyMetricView[];
  occupancy: MetricView;
}

export interface ComparisonRow {
  /** null = «Total clínica». */
  locationId: string | null;
  name: string;
  isActive: boolean;
  /** Zona de la sede (null en el total, que mezcla las de cada sede). */
  timeZone: string | null;
  /** ¿Hubo algún cobro, producción o cita (atendida, no-show o cancelada tarde) en el período? */
  hasActivity: boolean;
  metrics: ComparisonMetrics;
}

export interface LocationsComparison {
  from: string;
  to: string;
  compare: CompareMode;
  previousFrom: string | null;
  previousTo: string | null;
  currency: string | null;
  kpis: KpiDefinition[];
  locations: ComparisonRow[];
  total: ComparisonRow;
  hasActivity: boolean;
}

function hasActivity(a: PeriodAggregates): boolean {
  const anyAmount = (map: ReadonlyMap<string, number>) =>
    [...map.values()].some((v) => v !== 0);
  return (
    anyAmount(a.production) ||
    anyAmount(a.collected) ||
    a.completed > 0 ||
    a.noShow > 0 ||
    a.lateCancellations > 0
  );
}

function metric(
  key: KpiKey,
  value: number | null,
  previous: number | null | undefined,
): MetricView {
  if (previous === undefined) {
    return { value, previous: null, change: null, trend: null };
  }
  return {
    value,
    previous,
    change: changeOf(key, value, previous),
    trend: trendOf(key, value, previous),
  };
}

function currencyMetrics(
  key: KpiKey,
  current: CurrencyValue[],
  previous: CurrencyValue[] | undefined,
): CurrencyMetricView[] {
  return current.map(({ currency, value }) => ({
    currency,
    ...metric(
      key,
      value,
      previous &&
        (previous.find((p) => p.currency === currency)?.value ?? null),
    ),
  }));
}

/** Las métricas de una fila: el período y, si se compara, el anterior. */
function metricsOf(
  current: PeriodAggregates,
  previous: PeriodAggregates | undefined,
): ComparisonMetrics {
  const currencies = currenciesOf(previous ? [current, previous] : [current]);
  const now = computeKpis(current, currencies);
  const before: KpiValues | undefined = previous
    ? computeKpis(previous, currencies)
    : undefined;
  return {
    production: currencyMetrics(
      'production',
      now.production,
      before?.production,
    ),
    collected: currencyMetrics('collected', now.collected, before?.collected),
    collectionRate: currencyMetrics(
      'collectionRate',
      now.collectionRate,
      before?.collectionRate,
    ),
    completedAppointments: metric(
      'completedAppointments',
      now.completedAppointments,
      before?.completedAppointments,
    ),
    noShowRate: metric('noShowRate', now.noShowRate, before?.noShowRate),
    newPatients: metric('newPatients', now.newPatients, before?.newPatients),
    averageTicket: currencyMetrics(
      'averageTicket',
      now.averageTicket,
      before?.averageTicket,
    ),
    occupancy: metric('occupancy', now.occupancy, before?.occupancy),
  };
}

/**
 * «Comparar sedes» (DX-014, solo ADMIN): los ocho indicadores de
 * `kpi-definitions` por sede y para el total de las sedes que el usuario ve,
 * frente al período anterior o al mismo del año anterior. La base de datos
 * suma (una consulta por fuente y período, nunca por sede); aquí solo se
 * dividen y comparan las sumas.
 */
@Injectable()
export class GetLocationsComparisonUseCase {
  constructor(
    @Inject(LOCATIONS_COMPARISON_REPOSITORY)
    private readonly repo: LocationsComparisonRepository,
  ) {}

  private validated(from: string, to: string): CivilPeriod {
    const validFrom = parseCivilDate(from);
    const validTo = parseCivilDate(to);
    if (!validFrom || !validTo || validFrom > validTo) {
      throw new BadRequestException(INVALID_PERIOD_MESSAGE);
    }
    if (
      civilDaysInclusive(validFrom, validTo) > LOCATIONS_COMPARISON_MAX_DAYS
    ) {
      throw new BadRequestException(PERIOD_TOO_LONG_MESSAGE);
    }
    return { from: validFrom, to: validTo };
  }

  async execute(input: LocationsComparisonInput): Promise<LocationsComparison> {
    const period = this.validated(input.from, input.to);
    const previousPeriod = comparisonPeriod(
      period.from,
      period.to,
      input.compare,
    );
    const locations = await this.repo.listLocations(input.allowedLocationIds);
    const [current, previous] = await Promise.all([
      this.repo.aggregate(period, locations, input.currency),
      previousPeriod
        ? this.repo.aggregate(previousPeriod, locations, input.currency)
        : Promise.resolve(undefined),
    ]);

    const rows = locations.map((location) =>
      this.row(location, current, previous),
    );
    const totalNow = this.totalOf(locations, current);
    const totalBefore = previous && this.totalOf(locations, previous);
    const total: ComparisonRow = {
      locationId: null,
      name: TOTAL_ROW_NAME,
      isActive: true,
      timeZone: null,
      hasActivity: hasActivity(totalNow),
      metrics: metricsOf(totalNow, totalBefore),
    };
    return {
      from: period.from,
      to: period.to,
      compare: input.compare,
      previousFrom: previousPeriod?.from ?? null,
      previousTo: previousPeriod?.to ?? null,
      currency: input.currency ?? null,
      kpis: KPI_KEYS.map((key) => KPI_DEFINITIONS[key]),
      locations: rows,
      total,
      hasActivity: total.hasActivity,
    };
  }

  private row(
    location: ComparisonLocation,
    current: PeriodAggregation,
    previous: PeriodAggregation | undefined,
  ): ComparisonRow {
    const now = current.byLocation.get(location.id) ?? EMPTY_AGGREGATES;
    const before = previous
      ? (previous.byLocation.get(location.id) ?? EMPTY_AGGREGATES)
      : undefined;
    return {
      locationId: location.id,
      name: location.name,
      isActive: location.isActive,
      timeZone: location.timeZone,
      hasActivity: hasActivity(now),
      metrics: metricsOf(now, before),
    };
  }

  private totalOf(
    locations: readonly ComparisonLocation[],
    aggregation: PeriodAggregation,
  ): PeriodAggregates {
    return combineAggregates(
      locations.map(
        (l) => aggregation.byLocation.get(l.id) ?? EMPTY_AGGREGATES,
      ),
      aggregation.attendedPatients,
    );
  }
}
