import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { round2 } from '../../../shared/money/money';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { civilDateIn, zonedStartOfDay } from '../../../shared/time/civil-day';
import { GetReceivablesAgingUseCase } from '../../receivables/application/use-cases/get-receivables-aging.use-case';
import {
  GetLocationsComparisonUseCase,
  type ComparisonRow,
  type CurrencyMetricView,
  type LocationsComparisonWithNoShows,
  type NoShowCount,
} from '../../reports/application/use-cases/get-locations-comparison.use-case';
import { GetQuoteFunnelUseCase } from '../../reports/application/use-cases/get-quote-funnel.use-case';
import {
  WEEKLY_DIGEST_CLOCK,
  WEEKLY_DIGEST_REPOSITORY,
  type DigestLocation,
  type OpenCashSession,
  type WeeklyDigestClock,
  type WeeklyDigestRepository,
} from '../domain/ports/weekly-digest-repository.port';
import type {
  CashFigures,
  ComparisonFigures,
  CurrencyPair,
  DigestScopeSources,
  DigestSources,
  QuoteFigures,
  QuoteWeekFigures,
  ReceivablesFigures,
  SourceResult,
} from '../domain/weekly-digest';
import { weekBefore, type DigestWeek } from '../domain/weekly-digest-schedule';

/**
 * Actor del embudo de presupuestos para el resumen: ADMIN de toda la clínica
 * (el embudo exige uno; el ADMIN ve todo, así que el id no filtra nada).
 */
const DIGEST_FUNNEL_ACTOR = {
  userId: '00000000-0000-0000-0000-000000000000',
  role: ClinicRole.ADMIN,
  permissions: [],
} as const;

const FAILED = { ok: false } as const;

function ok<T>(value: T): SourceResult<T> {
  return { ok: true, value };
}

function pairs(metrics: CurrencyMetricView[]): CurrencyPair[] {
  return metrics.map((m) => ({
    currency: m.currency,
    current: m.value,
    previous: m.previous,
    ...(m.previousUnattributed ? { previousUnattributed: true } : {}),
  }));
}

function comparisonOf(
  row: ComparisonRow | undefined,
  noShows: NoShowCount | undefined,
): SourceResult<ComparisonFigures> {
  if (!row || !noShows) return FAILED;
  const m = row.metrics;
  return ok({
    collected: pairs(m.collected),
    production: pairs(m.production),
    completedAppointments: {
      current: m.completedAppointments.value,
      previous: m.completedAppointments.previous,
    },
    noShows: { current: noShows.current, previous: noShows.previous },
    noShowRate: m.noShowRate.value,
    newPatients: {
      current: m.newPatients.value,
      previous: m.newPatients.previous,
    },
  });
}

/** Lo vencido de una moneda: la deuda menos las cuotas que aún no vencen («Mi día»). */
function overdueOf(buckets: {
  days0to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}): number {
  return round2(
    buckets.days0to30 +
      buckets.days31to60 +
      buckets.days61to90 +
      buckets.over90,
  );
}

/**
 * Lee las cifras del resumen semanal (DX-568, D5) de las MISMAS fuentes de
 * Reportes, con la clínica en el contexto y SIN sede ni restricción (como un
 * ADMIN en «Todas las sedes»). Cada fuente va por separado: si una falla, sus
 * cifras salen «No disponible» y el resto sigue. La cartera nunca llama al
 * proveedor de tasas (`offline`).
 */
@Injectable()
export class WeeklyDigestSources {
  private readonly logger = new Logger('WeeklyDigest');

  constructor(
    private readonly comparison: GetLocationsComparisonUseCase,
    private readonly funnel: GetQuoteFunnelUseCase,
    private readonly receivables: GetReceivablesAgingUseCase,
    @Inject(WEEKLY_DIGEST_REPOSITORY)
    private readonly repo: WeeklyDigestRepository,
    @Inject(WEEKLY_DIGEST_CLOCK) private readonly clock: WeeklyDigestClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  read(
    tenantId: string,
    week: DigestWeek,
    locations: DigestLocation[],
  ): Promise<DigestSources> {
    // Contexto propio: la cabecera de sede o las sedes del token de quien
    // pide la prueba no acotan el total de la clínica.
    return this.tenantContext.run(tenantId, () =>
      this.gather(tenantId, week, locations),
    );
  }

  private async attempt<T>(
    source: string,
    tenantId: string,
    work: () => Promise<T>,
  ): Promise<SourceResult<T>> {
    try {
      return ok(await work());
    } catch (error) {
      this.logger.warn({
        event: 'weekly_digest.source_failed',
        tenantId,
        source,
        error: error instanceof Error ? error.name : 'Error',
      });
      return FAILED;
    }
  }

  private async gather(
    tenantId: string,
    week: DigestWeek,
    locations: DigestLocation[],
  ): Promise<DigestSources> {
    const previousWeek = weekBefore(week);
    // En serie: cada fuente abre sus transacciones; así el resumen no ocupa
    // más de una conexión a la vez.
    const comparison = await this.attempt('comparison', tenantId, () =>
      this.comparison.executeWithNoShows({
        from: week.weekStart,
        to: week.weekEnd,
        compare: 'previous',
        allowedLocationIds: 'ALL',
      }),
    );
    const cash = await this.attempt('cash', tenantId, () =>
      this.repo.openCashSessions(),
    );
    const now = this.clock();

    const scope = async (
      locationId: string | null,
    ): Promise<DigestScopeSources> => ({
      comparison: this.comparisonFor(comparison, locationId),
      quotes: await this.attempt('quotes', tenantId, () =>
        this.quotes(week, previousWeek, locationId),
      ),
      receivables: await this.attempt('receivables', tenantId, () =>
        this.overdue(locationId),
      ),
      cash: this.cashFor(cash, locations, locationId, now),
    });

    const byLocation = [];
    for (const location of locations) {
      byLocation.push({
        locationId: location.id,
        name: location.name,
        ...(await scope(location.id)),
      });
    }
    return {
      week,
      previousWeek,
      locations: byLocation,
      total: await scope(null),
    };
  }

  private comparisonFor(
    result: SourceResult<LocationsComparisonWithNoShows>,
    locationId: string | null,
  ): SourceResult<ComparisonFigures> {
    if (!result.ok) return FAILED;
    const { report, noShows } = result.value;
    return locationId === null
      ? comparisonOf(report.total, noShows.total)
      : comparisonOf(
          report.locations.find((r) => r.locationId === locationId),
          noShows.byLocation.get(locationId),
        );
  }

  private async quotes(
    week: DigestWeek,
    previousWeek: DigestWeek,
    locationId: string | null,
  ): Promise<QuoteFigures> {
    const of = async (w: DigestWeek) => {
      const report = await this.funnel.execute({
        from: w.weekStart,
        to: w.weekEnd,
        ...(locationId ? { locationId } : {}),
        actor: DIGEST_FUNNEL_ACTOR,
        allowedLocationIds: 'ALL',
      });
      const [presented, accepted] = report.steps;
      const figures: QuoteWeekFigures = {
        presented: { count: presented.count, amount: presented.amount },
        accepted: { count: accepted.count, amount: accepted.amount },
        withoutRate: report.withoutRate.presentations,
      };
      return { currency: report.currency, figures };
    };
    const current = await of(week);
    const previous = await of(previousWeek);
    return {
      currency: current.currency,
      current: current.figures,
      previous: previous.figures,
    };
  }

  private async overdue(
    locationId: string | null,
  ): Promise<ReceivablesFigures> {
    const summary = await this.receivables.summary(
      locationId ? { locationId } : {},
      { offline: true },
    );
    return {
      overdue: summary.totals
        .map((t) => ({ currency: t.currency, amount: overdueOf(t.buckets) }))
        .filter((t) => t.amount !== 0),
      paymentsWithoutRateCount: summary.paymentsWithoutRateCount,
      rateProviderTimedOut: summary.rateProviderTimedOut,
      withoutRateByCurrency: Object.fromEntries(
        summary.withoutRateByCurrency.map((w) => [
          w.currency,
          {
            count: w.paymentsWithoutRateCount,
            timedOut: w.rateProviderTimedOut,
          },
        ]),
      ),
    };
  }

  /**
   * Turnos abiertos de la sede (o de todas las activas) y cuántos se
   * abrieron antes de hoy en la zona de SU sede.
   */
  private cashFor(
    result: SourceResult<OpenCashSession[]>,
    locations: DigestLocation[],
    locationId: string | null,
    now: Date,
  ): SourceResult<CashFigures> {
    if (!result.ok) return FAILED;
    const zones = new Map(locations.map((l) => [l.id, l.timeZone]));
    const sessions = result.value.filter((s) =>
      locationId === null
        ? zones.has(s.locationId)
        : s.locationId === locationId,
    );
    const openBeforeToday = sessions.filter((s) => {
      const zone = zones.get(s.locationId);
      if (!zone) return false;
      const startOfToday = zonedStartOfDay(civilDateIn(now, zone), zone);
      return s.openedAt.getTime() < startOfToday.getTime();
    }).length;
    return ok({ open: sessions.length, openBeforeToday });
  }
}
