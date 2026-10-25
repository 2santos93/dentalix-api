import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
  zonedStartOfDay,
} from '../../../../shared/time/civil-day';
import {
  comparisonPeriod,
  type CivilPeriod,
  type CompareMode,
} from '../../domain/comparison-period';
import {
  ATTRIBUTION_SENSITIVE_KPIS,
  changeOf,
  combineAggregates,
  computeKpis,
  currenciesCollectedWithoutProduction,
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
  type ProductionAttribution,
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
  /**
   * BE-045: solo presente (true) en producción y % de cobro cuando la
   * producción del período comparado en esa moneda no es base: sin `change`
   * ni `trend`.
   */
  previousUnattributed?: true;
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
  /**
   * BE-045: el período comparado no tiene toda su producción atribuida (empieza
   * antes de DX-050 y la clínica tiene realizados «Sin atribuir», o tuvo
   * cobros en alguna moneda sin producción). Producción y % de cobro de esas
   * monedas salen sin variación ni tendencia.
   */
  previousPeriodUnattributed: boolean;
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
  /** ¿Alguna fila (o el total) tiene `previousPeriodUnattributed`? */
  previousPeriodUnattributed: boolean;
}

/**
 * Monedas del período comparado cuya producción no es base (BE-045): todas
 * (`ALL`) o las de la lista. Sin comparación, ninguna.
 */
type UnattributedPrevious = 'ALL' | ReadonlySet<string>;

const NONE: UnattributedPrevious = new Set<string>();

function isUnattributed(
  unattributed: UnattributedPrevious,
  currency: string,
): boolean {
  return unattributed === 'ALL' || unattributed.has(currency);
}

function anyUnattributed(unattributed: UnattributedPrevious): boolean {
  return unattributed === 'ALL' || unattributed.size > 0;
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

const SENSITIVE: ReadonlySet<KpiKey> = new Set(ATTRIBUTION_SENSITIVE_KPIS);

function currencyMetrics(
  key: KpiKey,
  current: CurrencyValue[],
  previous: CurrencyValue[] | undefined,
  unattributed: UnattributedPrevious = NONE,
): CurrencyMetricView[] {
  return current.map(({ currency, value }) => {
    const view = metric(
      key,
      value,
      previous &&
        (previous.find((p) => p.currency === currency)?.value ?? null),
    );
    // BE-045: contra una producción incompleta, ni variación ni «mejora».
    if (SENSITIVE.has(key) && isUnattributed(unattributed, currency)) {
      return {
        currency,
        ...view,
        change: null,
        trend: null,
        previousUnattributed: true,
      };
    }
    return { currency, ...view };
  });
}

/**
 * ¿El período comparado empieza (a la medianoche de la zona de la sede) antes
 * de que la base registrara la producción atribuida, y quedan realizados «Sin
 * atribuir» que podrían caer en él? Sin realizados sin atribuir (una clínica
 * que empezó después de DX-050) no hay nada que falte.
 */
function startsBeforeAttribution(
  previous: CivilPeriod,
  timeZone: string,
  attribution: ProductionAttribution,
): boolean {
  return (
    attribution.hasUnattributed &&
    zonedStartOfDay(previous.from, timeZone).getTime() <
      attribution.attributedSince.getTime()
  );
}

/** Qué monedas del período comparado no son base para la producción. */
function unattributedOf(
  previous: PeriodAggregates | undefined,
  startsUnattributed: boolean,
): UnattributedPrevious {
  if (!previous) return NONE;
  if (startsUnattributed) return 'ALL';
  return currenciesCollectedWithoutProduction(previous);
}

/** Las métricas de una fila: el período y, si se compara, el anterior. */
function metricsOf(
  current: PeriodAggregates,
  previous: PeriodAggregates | undefined,
  unattributed: UnattributedPrevious,
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
      unattributed,
    ),
    collected: currencyMetrics('collected', now.collected, before?.collected),
    collectionRate: currencyMetrics(
      'collectionRate',
      now.collectionRate,
      before?.collectionRate,
      unattributed,
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
    const period = checkPeriodDays(from, to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > LOCATIONS_COMPARISON_MAX_DAYS) {
      throw new BadRequestException(PERIOD_TOO_LONG_MESSAGE);
    }
    return { from: period.from, to: period.to };
  }

  async execute(input: LocationsComparisonInput): Promise<LocationsComparison> {
    const period = this.validated(input.from, input.to);
    const previousPeriod = comparisonPeriod(
      period.from,
      period.to,
      input.compare,
    );
    const locations = await this.repo.listLocations(input.allowedLocationIds);
    const [current, previous, attribution] = await Promise.all([
      this.repo.aggregate(period, locations, input.currency),
      previousPeriod
        ? this.repo.aggregate(previousPeriod, locations, input.currency)
        : Promise.resolve(undefined),
      previousPeriod
        ? this.repo.productionAttribution()
        : Promise.resolve(undefined),
    ]);
    // BE-045: ¿el período comparado empieza, en la zona de la sede, antes de
    // que hubiera producción atribuible, con realizados «Sin atribuir»?
    const startsUnattributed = (location: ComparisonLocation): boolean =>
      previousPeriod !== null &&
      attribution !== undefined &&
      startsBeforeAttribution(previousPeriod, location.timeZone, attribution);

    const rows = locations.map((location) =>
      this.row(location, current, previous, startsUnattributed(location)),
    );
    const totalNow = this.totalOf(locations, current);
    const totalBefore = previous && this.totalOf(locations, previous);
    const totalUnattributed = unattributedOf(
      totalBefore,
      locations.some(startsUnattributed),
    );
    const total: ComparisonRow = {
      locationId: null,
      name: TOTAL_ROW_NAME,
      isActive: true,
      timeZone: null,
      hasActivity: hasActivity(totalNow),
      previousPeriodUnattributed: anyUnattributed(totalUnattributed),
      metrics: metricsOf(totalNow, totalBefore, totalUnattributed),
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
      previousPeriodUnattributed:
        total.previousPeriodUnattributed ||
        rows.some((r) => r.previousPeriodUnattributed),
    };
  }

  private row(
    location: ComparisonLocation,
    current: PeriodAggregation,
    previous: PeriodAggregation | undefined,
    startsUnattributed: boolean,
  ): ComparisonRow {
    const now = current.byLocation.get(location.id) ?? EMPTY_AGGREGATES;
    const before = previous
      ? (previous.byLocation.get(location.id) ?? EMPTY_AGGREGATES)
      : undefined;
    const unattributed = unattributedOf(before, startsUnattributed);
    return {
      locationId: location.id,
      name: location.name,
      isActive: location.isActive,
      timeZone: location.timeZone,
      hasActivity: hasActivity(now),
      previousPeriodUnattributed: anyUnattributed(unattributed),
      metrics: metricsOf(now, before, unattributed),
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
