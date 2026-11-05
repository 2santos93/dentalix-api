import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import {
  firstLocationWithRows,
  loadPeriodLocationZones,
} from '../../../shared/locations/location-time-zone';
import {
  civilPeriodByZone,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import type {
  UnallocatedLocation,
  UnallocatedPaymentsRepository,
  UnallocatedReport,
  UnallocatedScope,
  UnallocatedSums,
} from '../domain/ports/unallocated-payments-repository.port';
import {
  loadNettingFacts,
  nettedFacts,
  type NettingFact,
} from '../../payments/infrastructure/allocations/credit-netting-facts';
import { inPeriod, periodWindow, utcTimestamp } from './zoned-period-sql';
import { NON_BILLABLE_PLAN_STATUSES } from '../../treatment-plans/domain/plan-status-machine';

@Injectable()
export class PrismaUnallocatedPaymentsRepository implements UnallocatedPaymentsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listLocations(
    allowed: AllowedLocations,
  ): Promise<UnallocatedLocation[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, isActive: true },
      }),
    );
  }

  async locationInClinic(locationId: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const found = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { tenantId, id: locationId, deletedAt: null },
        select: { id: true },
      }),
    );
    return found !== null;
  }

  /** Las ramas por zona del período para esas sedes (DX-097). */
  private async branches(
    tx: Prisma.TransactionClient,
    tenantId: string,
    period: CivilPeriod,
    locationIds: readonly string[],
  ): Promise<ZonedPeriodBranch[]> {
    const zones = await loadPeriodLocationZones(
      tx,
      tenantId,
      locationIds,
      firstLocationWithRows(tx.payment, tenantId),
    );
    return civilPeriodByZone(period.from, period.to, zones.configured);
  }

  /** El filtro de fecha y sede del período: una rama por zona. */
  private periodFilter(
    branches: ZonedPeriodBranch[],
    alias: string,
  ): Prisma.Sql {
    const window = periodWindow(branches);
    const paidAt = Prisma.raw(`${alias}."paidAt"`);
    return Prisma.sql`${paidAt} >= ${utcTimestamp(window.start)}
           AND ${paidAt} < ${utcTimestamp(window.end)}
           AND ${inPeriod(Prisma.raw(`${alias}."locationId"`), paidAt, branches)}`;
  }

  /**
   * El informe en UNA foto (RepeatableRead) y UNA cascada de salidas por
   * petición: se leen los abonos de los planes que tienen algún abono en el
   * período y las sedes pedidas, se netean con `netUnallocated` (la misma regla
   * del detalle de un abono) y de ahí salen filas, total y totales.
   */
  async report(
    period: CivilPeriod,
    scope: UnallocatedScope,
    page?: { skip: number; take: number },
  ): Promise<UnallocatedReport> {
    const tenantId = this.requireTenantId();
    const empty: UnallocatedReport = {
      rows: [],
      total: 0,
      totals: [],
      withoutRateCount: 0,
    };
    if (scope.locationIds.length === 0) return empty;
    return this.prisma.runWithTenant(
      async (tx) => {
        const branches = await this.branches(
          tx,
          tenantId,
          period,
          scope.locationIds,
        );
        if (branches.length === 0) return empty;
        const inPayments = this.periodFilter(branches, 'p');
        const inScope = this.periodFilter(branches, 'q');
        // Solo los planes con algún abono en el período y las sedes.
        const planScope = Prisma.sql`tp."id" IN (
          SELECT q."treatmentPlanId" FROM "payments" q
           WHERE q."tenantId" = ${tenantId}::uuid
             AND q."deletedAt" IS NULL
             AND q."treatmentPlanId" IS NOT NULL
             AND ${inScope})`;
        const { facts, entries } = await loadNettingFacts(
          tx,
          tenantId,
          planScope,
        );
        const inRange = (f: NettingFact) =>
          branches.some(
            (b) =>
              b.locationIds.includes(f.locationId) &&
              f.paidAt >= b.start &&
              f.paidAt < b.end,
          );
        const listed = nettedFacts(facts, entries)
          .filter(({ fact, net }) => net.netCents > 0 && inRange(fact))
          .sort(
            (x, y) =>
              y.fact.paidAt.getTime() - x.fact.paidAt.getTime() ||
              (x.fact.id < y.fact.id ? -1 : x.fact.id > y.fact.id ? 1 : 0),
          );
        const sums = new Map<string, UnallocatedSums>();
        for (const { fact, net } of listed) {
          const sum = sums.get(fact.planCurrency) ?? {
            currency: fact.planCurrency,
            count: 0,
            allocatedCents: 0,
            unallocatedCents: 0,
          };
          sum.count += 1;
          sum.allocatedCents += fact.allocatedCents;
          sum.unallocatedCents += net.netCents;
          sums.set(fact.planCurrency, sum);
        }
        const slice = page
          ? listed.slice(page.skip, page.skip + page.take)
          : listed;
        // Sin base y en otra moneda que la del plan: falta la tasa de su día.
        const [noRate] = await tx.$queryRaw<{ total: bigint }[]>`
          SELECT count(*) AS "total"
            FROM "payments" p
            JOIN "treatment_plans" tp
              ON tp."tenantId" = p."tenantId" AND tp."id" = p."treatmentPlanId"
            JOIN "patients" pt
              ON pt."tenantId" = p."tenantId" AND pt."id" = p."patientId"
            LEFT JOIN "payment_plan_amounts" b
              ON b."tenantId" = p."tenantId" AND b."paymentId" = p."id"
           WHERE p."tenantId" = ${tenantId}::uuid
             AND p."deletedAt" IS NULL
             AND p."treatmentPlanId" IS NOT NULL
             AND tp."deletedAt" IS NULL
             AND tp."status"::text NOT IN (${Prisma.join([...NON_BILLABLE_PLAN_STATUSES])})
             AND pt."deletedAt" IS NULL
             AND b."paymentId" IS NULL
             AND p."currency" <> tp."currency"
             AND ${inPayments}`;
        return {
          rows: slice.map(({ fact, net }) => ({
            paymentId: fact.id,
            patientId: fact.patientId,
            patientName: fact.patientName,
            locationId: fact.locationId,
            locationName: fact.locationName,
            timeZone: fact.timeZone,
            paidAt: fact.paidAt,
            paymentAmount: fact.paymentAmount,
            paymentCurrency: fact.paymentCurrency,
            planId: fact.planId,
            planCurrency: fact.planCurrency,
            planCents: fact.planCents,
            allocatedCents: fact.allocatedCents,
            unallocatedCents: net.netCents,
          })),
          total: listed.length,
          totals: [...sums.values()].sort((x, y) =>
            x.currency.localeCompare(y.currency),
          ),
          withoutRateCount: Number(noRate.total),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
