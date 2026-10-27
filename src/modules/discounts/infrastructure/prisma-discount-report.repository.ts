import { Injectable } from '@nestjs/common';
import {
  DiscountReason,
  Prisma,
  PriceSource,
  TreatmentPlanStatus,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { loadPeriodLocationZones } from '../../../shared/locations/location-time-zone';
import { resolveReferenceLocation } from '../../../shared/locations/reference-location';
import {
  civilDateIn,
  civilPeriodByZone,
  civilRangeInZone,
} from '../../../shared/time/civil-day';
import type {
  DiscountReportQuery,
  DiscountReportRepository,
  DiscountReportRow,
  DiscountReportSummary,
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
  catalogPrice: Prisma.Decimal | null;
  price: Prisma.Decimal;
  priceReduction: Prisma.Decimal;
  itemDiscount: Prisma.Decimal;
  reason: DiscountReason | null;
  reasonNote: string | null;
  discountById: string | null;
  discountByName: string | null;
  discountAt: Date;
  locationId: string | null;
  locationName: string | null;
  priceSource: PriceSource | null;
  agreementName: string | null;
  basePrice: Prisma.Decimal | null;
  agreementReduction: Prisma.Decimal;
  agreementAssignedById: string | null;
  agreementAssignedByName: string | null;
  createdById: string | null;
  createdByName: string | null;
}

interface RawTotal {
  currency: string;
  items: bigint;
  gross: Prisma.Decimal;
  discount: Prisma.Decimal;
  agreementItems: bigint;
  agreementReduction: Prisma.Decimal;
  rows: bigint;
}

/**
 * La primera de `locationIds` a la que el informe atribuye algún ítem (sede del
 * descuento, de la presentación del plan o del precio), o null. Es un
 * superconjunto a propósito: mira cada columna por separado y no la sede que
 * el informe acaba eligiendo (`COALESCE`), así que puede pedir la zona de una
 * sede que al final no se usa; nunca deja fuera una fila sin avisar.
 */
async function firstDiscountLocation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationIds: string[],
): Promise<string | null> {
  const [found] = await tx.$queryRaw<{ locationId: string }[]>`
    SELECT x."locationId" FROM (
      SELECT i."discountLocationId" AS "locationId"
        FROM "treatment_plan_items" i
       WHERE i."tenantId" = ${tenantId}::uuid
         AND i."discountLocationId" = ANY(${locationIds}::uuid[])
      UNION ALL
      SELECT i."pricingLocationId"
        FROM "treatment_plan_items" i
       WHERE i."tenantId" = ${tenantId}::uuid
         AND i."pricingLocationId" = ANY(${locationIds}::uuid[])
      UNION ALL
      SELECT p."presentedLocationId"
        FROM "treatment_plans" p
       WHERE p."tenantId" = ${tenantId}::uuid
         AND p."presentedLocationId" = ANY(${locationIds}::uuid[])
    ) x
    LIMIT 1`;
  return found?.locationId ?? null;
}

/**
 * Informe de descuentos (DX-204). Una línea por ítem VIVO (sin `deletedAt`, de
 * un plan vivo y no anulado: ni rechazado ni cancelado) con descuento > 0 o con
 * el precio por debajo del de catálogo (SEC-041: la rebaja cuenta como
 * descuento y se firma igual), fechado por su descuento (`discountAt`; en
 * los anteriores a DX-204, el alta del ítem) y con la sede del descuento (o, si
 * no la tiene, la de presentación del plan). El periodo son días civiles de la
 * zona de CADA sede, como la caja (DX-097); sin sede, la de la sede
 * principal (R6).
 * Sirve el índice parcial `treatment_plan_items_tenant_effective_discount_at_idx`
 * (mismo predicado).
 *
 * SEC-047: entran también los ítems resueltos por convenio con rebaja
 * (`basePrice` > `catalogPrice`), aunque no tengan descuento propio; esa rama
 * del OR la sirve `treatment_plan_items_tenant_agreement_reduction_at_idx`.
 * La rebaja de convenio va en su columna y en sus propios totales: los de
 * DX-204 (ítems, bruto, descuento y %) se agregan con `FILTER` solo sobre las
 * líneas que cuentan como descuento, exactamente las mismas que antes de
 * SEC-047, así que no cambian al entrar una línea solo de convenio. Quién
 * asignó el convenio es el autor de la asignación de ESE convenio al paciente
 * más reciente creada no después del ítem (la que resolvió el precio); quién
 * creó el ítem, `createdById` (NULL antes de SEC-047). Con `professionalId`,
 * una fila cuenta como descuento si esa persona lo dio (como en DX-204) y
 * como rebaja de convenio si creó el ítem, asignó el convenio o dio su
 * descuento. Una línea solo de convenio sin sede de descuento ni de
 * presentación toma la sede con la que se resolvió el precio.
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
    const zones = await loadPeriodLocationZones(
      tx,
      tenantId,
      query.locationId ? [query.locationId] : undefined,
      (ids) => firstDiscountLocation(tx, tenantId, ids),
    );
    // Sin sede (ítem nunca presentado ni descontado en una): el día de la
    // sede principal (R6). Con una sede pedida esas filas no entran.
    const referenceId =
      query.locationId ??
      (await resolveReferenceLocation(tx, tenantId, null)).id;
    const zoneOf = (locationId: string | null) =>
      zones.zoneOf(locationId ?? referenceId);
    const branches = civilPeriodByZone(query.from, query.to, zones.configured);
    const fallback = query.locationId
      ? null
      : civilRangeInZone(query.from, query.to, zoneOf(null));
    const ranges = fallback ? [fallback, ...branches] : branches;
    const minStart = new Date(
      Math.min(...ranges.map((r) => r.start.getTime())),
    );
    const maxEnd = new Date(Math.max(...ranges.map((r) => r.end.getTime())));
    const inPeriod = Prisma.join(
      [
        ...(fallback
          ? [
              Prisma.sql`(d."locationId" IS NULL AND d."at" >= ${fallback.start} AND d."at" < ${fallback.end})`,
            ]
          : []),
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
    const prof = query.professionalId;
    const discountByMatch = prof
      ? Prisma.sql`r."discountById" = ${prof}::uuid`
      : Prisma.sql`TRUE`;
    const agreementByMatch = prof
      ? Prisma.sql`(r."discountById" = ${prof}::uuid
            OR r."createdById" = ${prof}::uuid
            OR r."agreementAssignedById" = ${prof}::uuid)`
      : Prisma.sql`TRUE`;
    const cte = Prisma.sql`
      WITH raw AS (
        SELECT i."id", i."planId", i."toothNumber", i."catalogItemId",
               i."catalogPrice", i."price",
               GREATEST(COALESCE(i."catalogPrice" - i."price", 0), 0) AS "priceReduction",
               i."discount" AS "itemDiscount",
               i."discountReason", i."discountReasonNote",
               i."discountById",
               i."priceSource", i."agreementName", i."basePrice",
               CASE WHEN i."agreementId" IS NOT NULL
                    THEN GREATEST(COALESCE(i."basePrice" - i."catalogPrice", 0), 0)
                    ELSE 0 END AS "agreementReduction",
               asg."createdById" AS "agreementAssignedById",
               i."createdById",
               COALESCE(i."discountAt", i."createdAt") AS "at",
               (i."discount" > 0 OR i."price" < i."catalogPrice") AS "isDiscount",
               COALESCE(i."discountLocationId", p."presentedLocationId",
                        CASE WHEN NOT (i."discount" > 0 OR i."price" < i."catalogPrice")
                             THEN i."pricingLocationId" END) AS "locationId",
               p."currency", p."patientId", p."status" AS "planStatus",
               p."optionLabel" AS "planOptionLabel", p."createdAt" AS "planCreatedAt"
          FROM "treatment_plan_items" i
          JOIN "treatment_plans" p
            ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
          LEFT JOIN LATERAL (
            SELECT pa."createdById"
              FROM "patient_agreements" pa
             WHERE pa."tenantId" = i."tenantId"
               AND pa."patientId" = i."patientId"
               AND pa."agreementId" = i."agreementId"
               AND pa."createdAt" <= i."createdAt"
             ORDER BY pa."createdAt" DESC, pa."id" DESC
             LIMIT 1
          ) asg ON i."agreementId" IS NOT NULL
         WHERE i."tenantId" = ${tenantId}::uuid
           AND (i."discount" > 0 OR i."price" < i."catalogPrice"
                OR (i."agreementId" IS NOT NULL AND i."basePrice" > i."catalogPrice"))
           AND i."deletedAt" IS NULL
           AND p."deletedAt" IS NULL
           AND p."status" NOT IN ('REJECTED', 'CANCELLED')
           AND COALESCE(i."discountAt", i."createdAt") >= ${minStart}
           AND COALESCE(i."discountAt", i."createdAt") < ${maxEnd}
      ),
      flagged AS (
        SELECT r.*,
               (COALESCE(r."isDiscount", FALSE) AND ${discountByMatch}) AS "countsAsDiscount",
               (r."agreementReduction" > 0 AND ${agreementByMatch}) AS "countsAsAgreement"
          FROM raw r
      ),
      d AS (
        SELECT * FROM flagged d
         WHERE (${inPeriod}) ${byLocation}
           AND (d."countsAsDiscount" OR d."countsAsAgreement")
      )`;
    return { cte, zoneOf };
  }

  summary(query: DiscountReportQuery): Promise<DiscountReportSummary> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const { cte } = await this.discounted(tx, tenantId, query);
      const rows = await tx.$queryRaw<RawTotal[]>`
        ${cte}
        SELECT d."currency",
               count(*) FILTER (WHERE d."countsAsDiscount") AS "items",
               COALESCE(sum(d."price" + d."priceReduction") FILTER (WHERE d."countsAsDiscount"), 0) AS "gross",
               COALESCE(sum(d."priceReduction" + d."itemDiscount") FILTER (WHERE d."countsAsDiscount"), 0) AS "discount",
               count(*) FILTER (WHERE d."countsAsAgreement") AS "agreementItems",
               COALESCE(sum(d."agreementReduction") FILTER (WHERE d."countsAsAgreement"), 0) AS "agreementReduction",
               count(*) AS "rows"
          FROM d
         GROUP BY d."currency"
         ORDER BY d."currency"`;
      return {
        totals: rows
          .filter((r) => r.items > 0n)
          .map((r) => ({
            currency: r.currency,
            items: Number(r.items),
            gross: r.gross.toNumber(),
            discount: r.discount.toNumber(),
          })),
        agreementTotals: rows
          .filter((r) => r.agreementItems > 0n)
          .map((r) => ({
            currency: r.currency,
            items: Number(r.agreementItems),
            reduction: r.agreementReduction.toNumber(),
          })),
        rows: rows.reduce((sum, r) => sum + Number(r.rows), 0),
      };
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
               d."catalogPrice", d."price", d."priceReduction", d."itemDiscount",
               d."discountReason" AS "reason",
               d."discountReasonNote" AS "reasonNote", d."discountById",
               u."fullName" AS "discountByName", d."at" AS "discountAt",
               d."locationId", l."name" AS "locationName",
               d."priceSource", d."agreementName", d."basePrice",
               d."agreementReduction", d."agreementAssignedById",
               ua."fullName" AS "agreementAssignedByName",
               d."createdById", uc."fullName" AS "createdByName"
          FROM d
          JOIN "patients" pa ON pa."tenantId" = ${tenantId}::uuid AND pa."id" = d."patientId"
          LEFT JOIN "dental_catalog_items" c
            ON c."tenantId" = ${tenantId}::uuid AND c."id" = d."catalogItemId"
          LEFT JOIN "users" u ON u."id" = d."discountById"
          LEFT JOIN "users" ua ON ua."id" = d."agreementAssignedById"
          LEFT JOIN "users" uc ON uc."id" = d."createdById"
          LEFT JOIN "locations" l
            ON l."tenantId" = ${tenantId}::uuid AND l."id" = d."locationId"
         ORDER BY d."at" DESC, d."id" DESC
         ${paging}`;
      return rows.map((r) => ({
        ...r,
        planCreatedOn: civilDateIn(r.planCreatedAt, zoneOf(r.locationId)),
        discountOn: civilDateIn(r.discountAt, zoneOf(r.locationId)),
        procedure: r.procedure ?? '',
        catalogPrice: r.catalogPrice?.toNumber() ?? null,
        price: r.price.toNumber(),
        priceReduction: r.priceReduction.toNumber(),
        itemDiscount: r.itemDiscount.toNumber(),
        discount: r.priceReduction.plus(r.itemDiscount).toNumber(),
        basePrice: r.basePrice?.toNumber() ?? null,
        agreementReduction: r.agreementReduction.toNumber(),
      }));
    });
  }
}
