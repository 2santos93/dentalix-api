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
} from '../domain/ports/unallocated-payments-repository.port';
import { inPeriod, periodWindow, utcTimestamp } from './zoned-period-sql';
import { NON_BILLABLE_PLAN_STATUSES } from '../../treatment-plans/domain/plan-status-machine';
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
  net: Prisma.Decimal;
}

interface SumsRow {
  currency: string;
  count: bigint;
  allocated: Prisma.Decimal;
  unallocated: Prisma.Decimal;
}

const cents = (value: Prisma.Decimal): number => toCents(value.toNumber());

/**
 * Los abonos a LISTAR, ya netos. `cand`: abonos vivos de un plan que se cobra
 * (ni cancelado ni rechazado, ver NON_BILLABLE_PLAN_STATUSES: ahí no hay
 * imputación posible, el dinero va al saldo a favor), de un paciente vivo, con
 * base y algo sin imputar (`allocated` suma las imputaciones VIVAS, la misma
 * fuente que `GET /payments/:id/allocations`). `credit_out`: lo que cada plan
 * ya sacó de su saldo a favor (devoluciones y traspasos de salida, DX-253,
 * asientos con signo en la moneda del plan). REGLA (DX-399, ronda 1): ese
 * dinero ya no está a cuenta; se descuenta por plan de los abonos MÁS
 * RECIENTES primero (LIFO), nunca por debajo de 0, y el abono que queda en 0
 * desaparece. La cascada recorre TODOS los abonos del plan; el período y las
 * sedes se aplican después, así un filtro no cambia la cifra de un abono.
 */
function netted(tenantId: string): Prisma.Sql {
  return Prisma.sql`
    WITH credit_out AS (
      SELECT e."treatmentPlanId" AS "planId", -sum(e."amount") AS "out"
        FROM "patient_credit_entries" e
       WHERE e."tenantId" = ${tenantId}::uuid
         AND e."kind" IN ('REFUND', 'TRANSFER_OUT')
       GROUP BY e."treatmentPlanId"
    ), cand AS (
      SELECT p."id" AS "paymentId", p."patientId", p."locationId", p."paidAt",
             p."amount" AS "paymentAmount", p."currency" AS "paymentCurrency",
             tp."id" AS "planId", b."currency" AS "planCurrency",
             b."amount" AS "planAmount", al."allocated",
             b."amount" - al."allocated" AS "un"
        FROM "payments" p
        JOIN "treatment_plans" tp
          ON tp."tenantId" = p."tenantId" AND tp."id" = p."treatmentPlanId"
        JOIN "patients" pt
          ON pt."tenantId" = p."tenantId" AND pt."id" = p."patientId"
        JOIN "payment_plan_amounts" b
          ON b."tenantId" = p."tenantId" AND b."paymentId" = p."id"
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(a."amount"), 0) AS "allocated"
            FROM "payment_allocations" a
           WHERE a."tenantId" = p."tenantId" AND a."paymentId" = p."id"
        ) al ON TRUE
       WHERE p."tenantId" = ${tenantId}::uuid
         AND p."deletedAt" IS NULL
         AND p."treatmentPlanId" IS NOT NULL
         AND tp."deletedAt" IS NULL
         AND tp."status"::text NOT IN (${Prisma.join([...NON_BILLABLE_PLAN_STATUSES])})
         AND pt."deletedAt" IS NULL
         AND b."amount" - al."allocated" > 0
    ), net AS (
      SELECT c.*,
             c."un" - LEAST(c."un", GREATEST(0, COALESCE(o."out", 0) - (
               sum(c."un") OVER (
                 PARTITION BY c."planId"
                 ORDER BY c."paidAt" DESC, c."paymentId" DESC
               ) - c."un"))) AS "net"
        FROM cand c
        LEFT JOIN credit_out o ON o."planId" = c."planId"
    )`;
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
  private periodFilter(
    branches: ZonedPeriodBranch[],
    alias: 'p' | 'n',
  ): Prisma.Sql {
    const window = periodWindow(branches);
    const paidAt = Prisma.raw(`${alias}."paidAt"`);
    return Prisma.sql`${paidAt} >= ${utcTimestamp(window.start)}
           AND ${paidAt} < ${utcTimestamp(window.end)}
           AND ${inPeriod(Prisma.raw(`${alias}."locationId"`), paidAt, branches)}`;
  }

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
        const inNet = this.periodFilter(branches, 'n');
        const inPayments = this.periodFilter(branches, 'p');
        const withNet = netted(tenantId);
        const limit =
          page === undefined
            ? Prisma.empty
            : Prisma.sql`OFFSET ${page.skip} LIMIT ${page.take}`;
        const [totalRow] = await tx.$queryRaw<{ total: bigint }[]>`
          ${withNet}
          SELECT count(*) AS "total" FROM net n
           WHERE n."net" > 0 AND ${inNet}`;
        const rows = await tx.$queryRaw<ListRow[]>`
          ${withNet}
          SELECT n."paymentId", pt."id" AS "patientId",
                 btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
                 l."id" AS "locationId", l."name" AS "locationName", l."timeZone",
                 n."paidAt", n."paymentAmount", n."paymentCurrency",
                 n."planId", n."planCurrency", n."planAmount", n."allocated",
                 n."net"
            FROM net n
            JOIN "patients" pt
              ON pt."tenantId" = ${tenantId}::uuid AND pt."id" = n."patientId"
            JOIN "locations" l
              ON l."tenantId" = ${tenantId}::uuid AND l."id" = n."locationId"
           WHERE n."net" > 0 AND ${inNet}
           ORDER BY n."paidAt" DESC, n."paymentId"
           ${limit}`;
        const sums = await tx.$queryRaw<SumsRow[]>`
          ${withNet}
          SELECT n."planCurrency" AS "currency", count(*) AS "count",
                 sum(n."allocated") AS "allocated", sum(n."net") AS "unallocated"
            FROM net n
           WHERE n."net" > 0 AND ${inNet}
           GROUP BY n."planCurrency"
           ORDER BY n."planCurrency"`;
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
              unallocatedCents: cents(r.net),
            };
          }),
          total: Number(totalRow.total),
          totals: sums.map((r) => ({
            currency: r.currency,
            count: Number(r.count),
            allocatedCents: cents(r.allocated),
            unallocatedCents: cents(r.unallocated),
          })),
          withoutRateCount: Number(noRate.total),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
