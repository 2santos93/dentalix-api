import { Injectable } from '@nestjs/common';
import {
  DiscountReason,
  ExchangeRateSource,
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
import { itemRates } from '../domain/reference-in-plan';
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
  catalogCurrency: string | null;
  referenceCurrency: string | null;
  referencePriceInPlan: Prisma.Decimal | null;
  basePriceInPlan: Prisma.Decimal | null;
  referenceRateFrom: Prisma.Decimal | null;
  referenceRateTo: Prisma.Decimal | null;
  referenceRateSource: ExchangeRateSource | null;
  referenceRateDate: Date | null;
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
  agreementUnmeasured: boolean;
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
  unmeasuredItems: bigint;
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
 * Sirve el índice parcial `treatment_plan_items_tenant_effective_ref_discount_at_idx`
 * (mismo predicado).
 *
 * SEC-047: entran también los ítems resueltos por convenio con rebaja
 * (`basePrice` > `catalogPrice`), aunque no tengan descuento propio; esa rama
 * del OR la sirve `treatment_plan_items_tenant_agreement_ref_reduction_at_idx`
 * (DX-513-ter; antes `treatment_plan_items_tenant_agreement_reduction_at_idx`).
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
 * DX-513-bis: un ítem con FOTO de la referencia (`referencePriceInPlan`,
 * congelada al escribirlo en la moneda del plan, con su tasa) se mide frente a
 * ella: rebaja de precio = max(0, referencePriceInPlan − price) y de convenio
 * = max(0, basePriceInPlan − referencePriceInPlan). El informe NUNCA convierte:
 * lee lo congelado, así que no cambia aunque cambien las tasas. La fila lleva
 * la moneda de la referencia, la cifra original y la tasa. Los totales
 * siguen por moneda del plan. Los índices parciales incluyen
 * `price < referencePriceInPlan` (migración 20261201090300).
 *
 * Ítems SIN foto (anteriores): como en DX-513, que sigue.
 *
 * DX-513-ter: un ítem de lista de convenio con el catálogo en otra moneda
 * congela al darlo de alta la base convertida con la tasa del día
 * (`basePriceInPlan`), y su rebaja de convenio se mide con la misma
 * expresión de la foto. Un ítem de convenio con el catálogo en otra moneda
 * conocida y SIN base congelada (no había tasa, o es anterior) no se puede
 * medir sin convertir al consultar: entra como `agreementUnmeasured`, sin
 * importe, con su propio recuento por moneda, y no suma en los totales de
 * convenio. Las dos ramas nuevas del WHERE las sirve el índice parcial
 * `treatment_plan_items_tenant_agreement_ref_reduction_at_idx` (migración
 * 20261202090000, que sustituye al de SEC-047).
 *
 * DX-513: la rebaja de precio y la de convenio no cuentan frente a una
 * referencia en otra moneda CONOCIDA (`referenceInOtherCurrency` del
 * dominio): ese ítem no es un descuento y no entra en las filas ni en los
 * totales (si además tiene `discount`, entra solo por él). Con
 * "catalogCurrency" NULL (moneda desconocida) cuenta como hasta ahora. No se enseña
 * aparte como «moneda distinta»: no es un descuento, y sumarlo mezclaría
 * monedas. El WHERE sigue siendo el predicado (solo de columnas del ítem) de
 * los dos índices parciales, que quedan como superconjunto; la moneda se
 * filtra en `flagged`/`d`.
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
    // DX-513: la referencia (`catalogPrice`) cuenta si salió de una lista
    // (DX-105 solo toma listas en la moneda del plan) o si la moneda del
    // catálogo congelada en el ítem (DX-502) es la del plan o NO SE SABE
    // (NULL: cuenta como hoy, decisión de producto). Solo con una moneda
    // conocida y distinta, bajar de ella no es un descuento ni una rebaja de
    // convenio: no se resta entre monedas. Es `referenceInOtherCurrency` del
    // dominio, negado.
    const referenceInPlanCurrency = Prisma.sql`COALESCE(i."priceSource" IN ('PRICE_LIST', 'AGREEMENT_PRICE_LIST'), FALSE)
                 OR i."catalogCurrency" IS NULL
                 OR i."catalogCurrency" = p."currency"`;
    // DX-513-bis: con foto, frente a la referencia congelada en la moneda del
    // plan; sin ella, la regla de DX-513.
    const hasSnapshot = Prisma.sql`i."referencePriceInPlan" IS NOT NULL`;
    const priceBelowReference = Prisma.sql`(CASE WHEN ${hasSnapshot}
                 THEN i."price" < i."referencePriceInPlan"
                 ELSE (i."price" < i."catalogPrice" AND (${referenceInPlanCurrency})) END)`;
    const cte = Prisma.sql`
      WITH raw AS (
        SELECT i."id", i."planId", i."toothNumber", i."catalogItemId",
               i."catalogPrice", i."catalogCurrency", i."price",
               CASE WHEN i."catalogPrice" IS NULL THEN NULL
                    ELSE COALESCE(i."referenceCurrency",
                                  CASE WHEN i."priceSource" IN ('PRICE_LIST', 'AGREEMENT_PRICE_LIST')
                                       THEN p."currency"
                                       ELSE i."catalogCurrency" END) END AS "referenceCurrency",
               i."referencePriceInPlan", i."basePriceInPlan",
               i."referenceRateFrom", i."referenceRateTo",
               i."referenceRateSource", i."referenceRateDate",
               CASE WHEN ${hasSnapshot}
                    THEN GREATEST(i."referencePriceInPlan" - i."price", 0)
                    WHEN (${referenceInPlanCurrency})
                    THEN GREATEST(COALESCE(i."catalogPrice" - i."price", 0), 0)
                    ELSE 0 END AS "priceReduction",
               i."discount" AS "itemDiscount",
               i."discountReason", i."discountReasonNote",
               i."discountById",
               i."priceSource", i."agreementName", i."basePrice",
               CASE WHEN i."agreementId" IS NULL THEN 0
                    WHEN ${hasSnapshot}
                    THEN GREATEST(COALESCE(i."basePriceInPlan" - i."referencePriceInPlan", 0), 0)
                    WHEN (i."catalogCurrency" IS NULL
                          OR i."catalogCurrency" = p."currency")
                    THEN GREATEST(COALESCE(i."basePrice" - i."catalogPrice", 0), 0)
                    ELSE 0 END AS "agreementReduction",
               -- DX-513-ter: convenio con el catálogo en otra moneda conocida y
               -- sin la base congelada en la del plan: no se puede medir.
               (i."agreementId" IS NOT NULL AND i."basePrice" IS NOT NULL
                  AND i."basePriceInPlan" IS NULL
                  AND i."catalogCurrency" IS NOT NULL
                  AND i."catalogCurrency" <> p."currency") AS "agreementUnmeasured",
               asg."createdById" AS "agreementAssignedById",
               i."createdById",
               COALESCE(i."discountAt", i."createdAt") AS "at",
               (i."discount" > 0 OR ${priceBelowReference}) AS "isDiscount",
               COALESCE(i."discountLocationId", p."presentedLocationId",
                        CASE WHEN NOT COALESCE(i."discount" > 0 OR ${priceBelowReference}, FALSE)
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
                OR i."price" < i."referencePriceInPlan"
                OR (i."agreementId" IS NOT NULL
                    AND (i."basePrice" > i."catalogPrice"
                         OR i."basePriceInPlan" > i."referencePriceInPlan"
                         OR (i."basePriceInPlan" IS NULL AND i."basePrice" IS NOT NULL
                             AND i."catalogCurrency" IS NOT NULL
                             AND i."referenceCurrency" IS DISTINCT FROM i."catalogCurrency"))))
           AND i."deletedAt" IS NULL
           AND p."deletedAt" IS NULL
           AND p."status" NOT IN ('REJECTED', 'CANCELLED')
           AND COALESCE(i."discountAt", i."createdAt") >= ${minStart}
           AND COALESCE(i."discountAt", i."createdAt") < ${maxEnd}
      ),
      flagged AS (
        SELECT r.*,
               (COALESCE(r."isDiscount", FALSE) AND ${discountByMatch}) AS "countsAsDiscount",
               (r."agreementReduction" > 0 AND ${agreementByMatch}) AS "countsAsAgreement",
               (r."agreementUnmeasured" AND ${agreementByMatch}) AS "countsAsUnmeasured"
          FROM raw r
      ),
      d AS (
        SELECT * FROM flagged d
         WHERE (${inPeriod}) ${byLocation}
           AND (d."countsAsDiscount" OR d."countsAsAgreement" OR d."countsAsUnmeasured")
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
               count(*) FILTER (WHERE d."countsAsUnmeasured") AS "unmeasuredItems",
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
        agreementUnmeasuredTotals: rows
          .filter((r) => r.unmeasuredItems > 0n)
          .map((r) => ({
            currency: r.currency,
            items: Number(r.unmeasuredItems),
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
               d."catalogPrice", d."catalogCurrency", d."referenceCurrency", d."referencePriceInPlan",
               d."basePriceInPlan", d."referenceRateFrom", d."referenceRateTo",
               d."referenceRateSource", d."referenceRateDate",
               d."price", d."priceReduction", d."itemDiscount",
               d."discountReason" AS "reason",
               d."discountReasonNote" AS "reasonNote", d."discountById",
               u."fullName" AS "discountByName", d."at" AS "discountAt",
               d."locationId", l."name" AS "locationName",
               d."priceSource", d."agreementName", d."basePrice",
               d."agreementReduction", d."agreementUnmeasured", d."agreementAssignedById",
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
      return rows.map(
        ({
          referenceRateFrom,
          referenceRateTo,
          referenceRateSource,
          referenceRateDate,
          ...r
        }) => {
          const frozen =
            referenceRateFrom &&
            referenceRateTo &&
            referenceRateSource &&
            referenceRateDate
              ? {
                  fromPerBase: referenceRateFrom.toNumber(),
                  toPerBase: referenceRateTo.toNumber(),
                  source: referenceRateSource,
                  rateDate: referenceRateDate.toISOString().slice(0, 10),
                }
              : null;
          // DX-513-ter: la tasa de una lista es la de la base (`baseRate`).
          const { referenceRate, baseRate } = itemRates(r.priceSource, frozen);
          return {
            ...r,
            planCreatedOn: civilDateIn(r.planCreatedAt, zoneOf(r.locationId)),
            discountOn: civilDateIn(r.discountAt, zoneOf(r.locationId)),
            procedure: r.procedure ?? '',
            catalogPrice: r.catalogPrice?.toNumber() ?? null,
            referencePriceInPlan: r.referencePriceInPlan?.toNumber() ?? null,
            basePriceInPlan: r.basePriceInPlan?.toNumber() ?? null,
            rate: referenceRate,
            baseRate,
            price: r.price.toNumber(),
            priceReduction: r.priceReduction.toNumber(),
            itemDiscount: r.itemDiscount.toNumber(),
            discount: r.priceReduction.plus(r.itemDiscount).toNumber(),
            basePrice: r.basePrice?.toNumber() ?? null,
            agreementReduction: r.agreementReduction.toNumber(),
          };
        },
      );
    });
  }
}
