import { Injectable } from '@nestjs/common';
import { DiscountReason, Prisma, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { loadLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../shared/locations/default-business-hours';
import {
  civilDateIn,
  civilPeriodByZone,
  civilRangeInZone,
} from '../../../shared/time/civil-day';
import type {
  DiscountReportQuery,
  DiscountReportRepository,
  DiscountReportRow,
  DiscountReportTotal,
} from '../domain/ports/discount-report-repository.port';

interface RawRow {
  itemId: string;
  planId: string;
  planStatus: TreatmentPlanStatus;
  planOptionLabel: string | null;
  planCreatedAt: Date;
  patientId: string;
  patientName: string;
  toothNumber: string;
  procedure: string | null;
  currency: string;
  price: Prisma.Decimal;
  discount: Prisma.Decimal;
  reason: DiscountReason | null;
  reasonNote: string | null;
  discountById: string | null;
  discountByName: string | null;
  discountAt: Date;
  locationId: string | null;
  locationName: string | null;
}

interface RawTotal {
  currency: string;
  items: bigint;
  gross: Prisma.Decimal;
  discount: Prisma.Decimal;
}

/**
 * Informe de descuentos (DX-204). Una línea por ítem VIVO (sin `deletedAt`, de
 * un plan vivo y no anulado: ni rechazado ni cancelado) con descuento > 0, fechado por su descuento (`discountAt`; en
 * los anteriores a DX-204, el alta del ítem) y con la sede del descuento (o, si
 * no la tiene, la de presentación del plan). El periodo son días civiles de la
 * zona de CADA sede, como la caja (DX-097); sin sede, la zona por defecto.
 * Sirve el índice parcial `treatment_plan_items_tenant_discounted_at_idx`.
 *
 * Rechazados y cancelados no cuentan: ese descuento nunca se cobró, y una
 * alternativa (DX-040) copia los descuentos de su opción de origen, así que al
 * aceptar una opción la hermana rechazada lo duplicaría.
 */
@Injectable()
export class PrismaDiscountReportRepository implements DiscountReportRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  findLocation(
    locationId: string,
  ): Promise<{ id: string; name: string } | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { id: locationId, tenantId },
        select: { id: true, name: true },
      }),
    );
  }

  /** CTE con los ítems del periodo y los filtros, común a filas y totales. */
  private async discounted(
    tx: Prisma.TransactionClient,
    tenantId: string,
    query: DiscountReportQuery,
  ): Promise<{
    cte: Prisma.Sql;
    zoneOf: (locationId: string | null) => string;
  }> {
    const zones = await loadLocationTimeZones(tx, tenantId);
    const zoneOf = (locationId: string | null) =>
      (locationId && zones.get(locationId)) || DEFAULT_BUSINESS_HOURS_TIMEZONE;
    const branches = civilPeriodByZone(query.from, query.to, zones);
    const fallback = civilRangeInZone(
      query.from,
      query.to,
      DEFAULT_BUSINESS_HOURS_TIMEZONE,
    );
    const starts = [fallback.start, ...branches.map((b) => b.start)];
    const ends = [fallback.end, ...branches.map((b) => b.end)];
    const minStart = new Date(Math.min(...starts.map((d) => d.getTime())));
    const maxEnd = new Date(Math.max(...ends.map((d) => d.getTime())));
    const inPeriod = Prisma.join(
      [
        Prisma.sql`(d."locationId" IS NULL AND d."at" >= ${fallback.start} AND d."at" < ${fallback.end})`,
        ...branches.map(
          (b) =>
            Prisma.sql`(d."locationId" = ANY(${b.locationIds}::uuid[]) AND d."at" >= ${b.start} AND d."at" < ${b.end})`,
        ),
      ],
      ' OR ',
    );
    const byLocation = query.locationId
      ? Prisma.sql`AND d."locationId" = ${query.locationId}::uuid`
      : Prisma.empty;
    const byProfessional = query.professionalId
      ? Prisma.sql`AND d."discountById" = ${query.professionalId}::uuid`
      : Prisma.empty;
    const cte = Prisma.sql`
      WITH raw AS (
        SELECT i."id", i."planId", i."toothNumber", i."catalogItemId",
               i."price", i."discount", i."discountReason", i."discountReasonNote",
               i."discountById",
               COALESCE(i."discountAt", i."createdAt") AS "at",
               COALESCE(i."discountLocationId", p."presentedLocationId") AS "locationId",
               p."currency", p."patientId", p."status" AS "planStatus",
               p."optionLabel" AS "planOptionLabel", p."createdAt" AS "planCreatedAt"
          FROM "treatment_plan_items" i
          JOIN "treatment_plans" p
            ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
         WHERE i."tenantId" = ${tenantId}::uuid
           AND i."discount" > 0
           AND i."deletedAt" IS NULL
           AND p."deletedAt" IS NULL
           AND p."status" NOT IN ('REJECTED', 'CANCELLED')
           AND COALESCE(i."discountAt", i."createdAt") >= ${minStart}
           AND COALESCE(i."discountAt", i."createdAt") < ${maxEnd}
      ),
      d AS (
        SELECT * FROM raw d
         WHERE (${inPeriod}) ${byLocation} ${byProfessional}
      )`;
    return { cte, zoneOf };
  }

  totals(query: DiscountReportQuery): Promise<DiscountReportTotal[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const { cte } = await this.discounted(tx, tenantId, query);
      const rows = await tx.$queryRaw<RawTotal[]>`
        ${cte}
        SELECT d."currency", count(*) AS "items",
               sum(d."price") AS "gross", sum(d."discount") AS "discount"
          FROM d
         GROUP BY d."currency"
         ORDER BY d."currency"`;
      return rows.map((r) => ({
        currency: r.currency,
        items: Number(r.items),
        gross: r.gross.toNumber(),
        discount: r.discount.toNumber(),
      }));
    });
  }

  rows(
    query: DiscountReportQuery,
    page?: { offset: number; limit: number },
  ): Promise<DiscountReportRow[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const { cte, zoneOf } = await this.discounted(tx, tenantId, query);
      const paging = page
        ? Prisma.sql`LIMIT ${page.limit} OFFSET ${page.offset}`
        : Prisma.empty;
      const rows = await tx.$queryRaw<RawRow[]>`
        ${cte}
        SELECT d."id" AS "itemId", d."planId", d."planStatus", d."planOptionLabel",
               d."planCreatedAt", d."patientId",
               concat_ws(' ', pa."firstName", pa."lastName") AS "patientName",
               d."toothNumber", c."labelEs" AS "procedure", d."currency",
               d."price", d."discount", d."discountReason" AS "reason",
               d."discountReasonNote" AS "reasonNote", d."discountById",
               u."fullName" AS "discountByName", d."at" AS "discountAt",
               d."locationId", l."name" AS "locationName"
          FROM d
          JOIN "patients" pa ON pa."tenantId" = ${tenantId}::uuid AND pa."id" = d."patientId"
          LEFT JOIN "dental_catalog_items" c
            ON c."tenantId" = ${tenantId}::uuid AND c."id" = d."catalogItemId"
          LEFT JOIN "users" u ON u."id" = d."discountById"
          LEFT JOIN "locations" l
            ON l."tenantId" = ${tenantId}::uuid AND l."id" = d."locationId"
         ORDER BY d."at" DESC, d."id" DESC
         ${paging}`;
      return rows.map((r) => ({
        ...r,
        planCreatedOn: civilDateIn(r.planCreatedAt, zoneOf(r.locationId)),
        discountOn: civilDateIn(r.discountAt, zoneOf(r.locationId)),
        procedure: r.procedure ?? '',
        price: r.price.toNumber(),
        discount: r.discount.toNumber(),
      }));
    });
  }
}
