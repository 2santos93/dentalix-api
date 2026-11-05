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
  UnallocatedPaymentRow,
  UnallocatedPaymentsRepository,
  UnallocatedScope,
  UnallocatedSums,
} from '../domain/ports/unallocated-payments-repository.port';
import { inPeriod, periodWindow, utcTimestamp } from './zoned-period-sql';
import { toCents } from '../../../shared/money/money';

interface ListRow {
  paymentId: string;
  patientId: string;
  patientName: string;
  locationId: string;
  locationName: string;
  timeZone: string;
  paidAt: Date;
  paymentAmount: Prisma.Decimal;
  paymentCurrency: string;
  planId: string;
  planCurrency: string;
  planAmount: Prisma.Decimal;
  allocated: Prisma.Decimal;
}

interface SumsRow {
  currency: string;
  count: bigint;
  allocated: Prisma.Decimal;
  unallocated: Prisma.Decimal;
}

const cents = (value: Prisma.Decimal): number => toCents(value.toNumber());

/**
 * Los abonos de un plan que se cobra (ni cancelado ni rechazado: ahí no hay
 * imputación posible, el dinero va al saldo a favor), vivos, de un paciente
 * vivo, con su base. `allocated` suma las imputaciones VIVAS del abono, la
 * misma fuente que `GET /payments/:id/allocations`.
 */
function livePayments(
  tenantId: string,
  period: Prisma.Sql,
  withBase: boolean,
): Prisma.Sql {
  return Prisma.sql`
          FROM "payments" p
          JOIN "treatment_plans" tp
            ON tp."tenantId" = p."tenantId" AND tp."id" = p."treatmentPlanId"
          JOIN "patients" pt
            ON pt."tenantId" = p."tenantId" AND pt."id" = p."patientId"
          JOIN "locations" l
            ON l."tenantId" = p."tenantId" AND l."id" = p."locationId"
          ${
            withBase
              ? Prisma.sql`JOIN "payment_plan_amounts" b
            ON b."tenantId" = p."tenantId" AND b."paymentId" = p."id"
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(a."amount"), 0) AS "allocated"
              FROM "payment_allocations" a
             WHERE a."tenantId" = p."tenantId" AND a."paymentId" = p."id"
          ) al ON TRUE`
              : Prisma.sql`LEFT JOIN "payment_plan_amounts" b
            ON b."tenantId" = p."tenantId" AND b."paymentId" = p."id"`
          }
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."deletedAt" IS NULL
           AND p."treatmentPlanId" IS NOT NULL
           AND tp."deletedAt" IS NULL
           AND tp."status" NOT IN ('CANCELLED', 'REJECTED')
           AND pt."deletedAt" IS NULL
           AND ${period}
           ${withBase ? Prisma.sql`AND b."amount" - al."allocated" > 0` : Prisma.sql`AND b."paymentId" IS NULL`}`;
}

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
  private periodFilter(branches: ZonedPeriodBranch[]): Prisma.Sql {
    const window = periodWindow(branches);
    return Prisma.sql`p."paidAt" >= ${utcTimestamp(window.start)}
           AND p."paidAt" < ${utcTimestamp(window.end)}
           AND ${inPeriod(Prisma.sql`p."locationId"`, Prisma.sql`p."paidAt"`, branches)}`;
  }

  async list(
    period: CivilPeriod,
    scope: UnallocatedScope,
    page?: { skip: number; take: number },
  ): Promise<{ rows: UnallocatedPaymentRow[]; total: number }> {
    const tenantId = this.requireTenantId();
    if (scope.locationIds.length === 0) return { rows: [], total: 0 };
    return this.prisma.runWithTenant(async (tx) => {
      const branches = await this.branches(
        tx,
        tenantId,
        period,
        scope.locationIds,
      );
      if (branches.length === 0) return { rows: [], total: 0 };
      const from = livePayments(tenantId, this.periodFilter(branches), true);
      const [{ total }] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS "total" ${from}`;
      const limit =
        page === undefined
          ? Prisma.empty
          : Prisma.sql`OFFSET ${page.skip} LIMIT ${page.take}`;
      const rows = await tx.$queryRaw<ListRow[]>`
        SELECT p."id" AS "paymentId", pt."id" AS "patientId",
               btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
               l."id" AS "locationId", l."name" AS "locationName", l."timeZone",
               p."paidAt", p."amount" AS "paymentAmount",
               p."currency" AS "paymentCurrency",
               tp."id" AS "planId", b."currency" AS "planCurrency",
               b."amount" AS "planAmount", al."allocated"
          ${from}
         ORDER BY p."paidAt" DESC, p."id"
          ${limit}`;
      return {
        rows: rows.map((r) => {
          const planCents = cents(r.planAmount);
          const allocatedCents = cents(r.allocated);
          return {
            paymentId: r.paymentId,
            patientId: r.patientId,
            patientName: r.patientName,
            locationId: r.locationId,
            locationName: r.locationName,
            timeZone: r.timeZone,
            paidAt: r.paidAt,
            paymentAmount: r.paymentAmount.toNumber(),
            paymentCurrency: r.paymentCurrency,
            planId: r.planId,
            planCurrency: r.planCurrency,
            planCents,
            allocatedCents,
            unallocatedCents: planCents - allocatedCents,
          };
        }),
        total: Number(total),
      };
    });
  }

  async totals(
    period: CivilPeriod,
    scope: UnallocatedScope,
  ): Promise<UnallocatedSums[]> {
    const tenantId = this.requireTenantId();
    if (scope.locationIds.length === 0) return [];
    return this.prisma.runWithTenant(async (tx) => {
      const branches = await this.branches(
        tx,
        tenantId,
        period,
        scope.locationIds,
      );
      if (branches.length === 0) return [];
      const from = livePayments(tenantId, this.periodFilter(branches), true);
      const rows = await tx.$queryRaw<SumsRow[]>`
        SELECT b."currency", count(*) AS "count",
               sum(al."allocated") AS "allocated",
               sum(b."amount" - al."allocated") AS "unallocated"
          ${from}
         GROUP BY b."currency"
         ORDER BY b."currency"`;
      return rows.map((r) => ({
        currency: r.currency,
        count: Number(r.count),
        allocatedCents: cents(r.allocated),
        unallocatedCents: cents(r.unallocated),
      }));
    });
  }

  async withoutRateCount(
    period: CivilPeriod,
    scope: UnallocatedScope,
  ): Promise<number> {
    const tenantId = this.requireTenantId();
    if (scope.locationIds.length === 0) return 0;
    return this.prisma.runWithTenant(async (tx) => {
      const branches = await this.branches(
        tx,
        tenantId,
        period,
        scope.locationIds,
      );
      if (branches.length === 0) return 0;
      const from = livePayments(tenantId, this.periodFilter(branches), false);
      const [{ total }] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS "total" ${from}`;
      return Number(total);
    });
  }
}
