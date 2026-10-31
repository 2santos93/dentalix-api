import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import { loadPeriodLocationZones } from '../../../shared/locations/location-time-zone';
import {
  civilPeriodByZone,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import type { ProcedureSums } from '../domain/production-by-procedure';
import type {
  ProductionByProcedureRepository,
  ProductionItemRow,
  ProductionLocation,
  ProductionProfessional,
  ProductionScope,
  UnattributedSums,
} from '../domain/ports/production-by-procedure-repository.port';
import { inPeriod, periodWindow, utcTimestamp } from './zoned-period-sql';

interface SumsRow {
  catalogItemId: string;
  code: string;
  label: string;
  category: string | null;
  currency: string;
  count: bigint;
  gross: Prisma.Decimal;
  discounts: Prisma.Decimal;
  catalogCount: bigint;
  catalogSum: Prisma.Decimal | null;
  catalogPricedNet: Prisma.Decimal | null;
}

interface UnattributedRow {
  currency: string;
  count: bigint;
  gross: Prisma.Decimal;
  discounts: Prisma.Decimal;
}

interface ItemRow {
  id: string;
  completedAt: Date;
  patientId: string | null;
  patientName: string | null;
  professionalId: string | null;
  professionalName: string | null;
  locationId: string;
  locationName: string;
  timeZone: string;
  toothNumber: string;
  currency: string;
  price: Prisma.Decimal;
  discount: Prisma.Decimal;
}

const dec = (value: Prisma.Decimal | null) => value?.toNumber() ?? 0;

/**
 * Lo común a las tres lecturas: ítem DONE vivo de un plan vivo, y los filtros
 * opcionales de quién lo realizó y de la categoría del catálogo (un EXISTS:
 * así la suma no arrastra las columnas de texto del catálogo).
 */
function common(scope: ProductionScope): Prisma.Sql {
  return Prisma.sql`i."status" = 'DONE'
             AND i."deletedAt" IS NULL
             AND p."deletedAt" IS NULL
             ${scope.professionalId !== undefined ? Prisma.sql`AND i."performedById" = ${scope.professionalId}::uuid` : Prisma.empty}
             ${
               scope.category !== undefined
                 ? Prisma.sql`AND EXISTS (
                 SELECT 1 FROM "dental_catalog_items" c
                  WHERE c."tenantId" = i."tenantId" AND c."id" = i."catalogItemId"
                    AND btrim(c."category") = ${scope.category})`
                 : Prisma.empty
             }`;
}

@Injectable()
export class PrismaProductionByProcedureRepository implements ProductionByProcedureRepository {
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
  ): Promise<ProductionLocation[]> {
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

  /**
   * Quien figura en algún realizado vivo de esas sedes. Va por las membresías
   * (también las retiradas: un ex-miembro sigue firmando su producción) con un
   * EXISTS sobre el índice de quien lo realizó, que para en el primero.
   */
  async listProfessionals(
    locationIds: readonly string[],
  ): Promise<ProductionProfessional[]> {
    const tenantId = this.requireTenantId();
    const ids = [...locationIds];
    if (ids.length === 0) return [];
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<ProductionProfessional[]>`
        SELECT DISTINCT m."userId", u."fullName"
          FROM "clinic_memberships" m
          JOIN "users" u ON u."id" = m."userId"
         WHERE m."tenantId" = ${tenantId}::uuid
           AND EXISTS (
             SELECT 1 FROM "treatment_plan_items" i
              WHERE i."tenantId" = m."tenantId"
                AND i."performedByMembershipId" = m."id"
                AND i."performedById" = m."userId"
                AND i."status" = 'DONE'
                AND i."deletedAt" IS NULL
                AND i."performedLocationId" = ANY(${ids}::uuid[]))`,
    );
    return rows.sort((a, b) =>
      a.fullName.localeCompare(b.fullName, 'es', { sensitivity: 'base' }),
    );
  }

  async listCategories(): Promise<string[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.dentalCatalogItem.findMany({
        where: {
          tenantId,
          kind: 'PROCEDURE',
          deletedAt: null,
          category: { not: null },
        },
        distinct: ['category'],
        select: { category: true },
      }),
    );
    // Recortadas, como las agrupa el reporte (`btrim`) y como filtra.
    return [
      ...new Set(
        rows.map((r) => r.category?.trim() ?? '').filter((c) => c !== ''),
      ),
    ].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  }

  /**
   * Las ramas por zona del período para esas sedes (DX-097). Una sede sin
   * zona y sin producción se ignora; con producción, 409 (G1).
   */
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
      async (ids) =>
        (
          await tx.treatmentPlanItem.findFirst({
            where: { tenantId, performedLocationId: { in: ids } },
            select: { performedLocationId: true },
          })
        )?.performedLocationId,
    );
    return civilPeriodByZone(period.from, period.to, zones.configured);
  }

  async aggregate(
    period: CivilPeriod,
    scope: ProductionScope,
  ): Promise<ProcedureSums[]> {
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
      const window = periodWindow(branches);
      // Suma por (procedimiento, moneda) —pocos grupos, HashAggregate— y
      // solo después pone el código y el nombre del catálogo. Los DONE del
      // período salen del índice parcial (tenantId, completedAt) de DX-014
      // en un mes; en 24 meses, de un recorrido (docs/perf/DX-423.md).
      const rows = await tx.$queryRaw<SumsRow[]>`
        SELECT s."catalogItemId", c."code", c."labelEs" AS "label",
               NULLIF(btrim(c."category"), '') AS "category", s."currency",
               s."count", s."gross", s."discounts",
               s."catalogCount", s."catalogSum", s."catalogPricedNet"
          FROM (
            SELECT i."catalogItemId", p."currency",
                   count(*) AS "count",
                   sum(i."price") AS "gross",
                   sum(i."discount") AS "discounts",
                   count(i."basePrice") AS "catalogCount",
                   sum(i."basePrice") AS "catalogSum",
                   sum(i."price" - i."discount")
                     FILTER (WHERE i."basePrice" IS NOT NULL) AS "catalogPricedNet"
              FROM "treatment_plan_items" i
              JOIN "treatment_plans" p
                ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
             WHERE i."tenantId" = ${tenantId}::uuid
               AND ${common(scope)}
               AND i."completedAt" >= ${utcTimestamp(window.start)}
               AND i."completedAt" < ${utcTimestamp(window.end)}
               AND ${inPeriod(Prisma.sql`i."performedLocationId"`, Prisma.sql`i."completedAt"`, branches)}
             GROUP BY 1, 2
          ) s
          JOIN "dental_catalog_items" c
            ON c."tenantId" = ${tenantId}::uuid AND c."id" = s."catalogItemId"`;
      return rows.map((r) => ({
        catalogItemId: r.catalogItemId,
        code: r.code,
        label: r.label,
        category: r.category,
        currency: r.currency,
        count: Number(r.count),
        gross: dec(r.gross),
        discounts: dec(r.discounts),
        catalogCount: Number(r.catalogCount),
        catalogSum: dec(r.catalogSum),
        catalogPricedNet: dec(r.catalogPricedNet),
      }));
    });
  }

  async unattributed(
    scope: ProductionScope,
    includeWithoutLocation: boolean,
  ): Promise<UnattributedSums[]> {
    const tenantId = this.requireTenantId();
    const ids = [...scope.locationIds];
    if (ids.length === 0 && !includeWithoutLocation) return [];
    const where = includeWithoutLocation
      ? Prisma.sql`(i."performedLocationId" IS NULL OR i."performedLocationId" = ANY(${ids}::uuid[]))`
      : Prisma.sql`i."performedLocationId" = ANY(${ids}::uuid[])`;
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<UnattributedRow[]>`
        SELECT p."currency", count(*) AS "count",
               sum(i."price") AS "gross", sum(i."discount") AS "discounts"
          FROM "treatment_plan_items" i
          JOIN "treatment_plans" p
            ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
         WHERE i."tenantId" = ${tenantId}::uuid
           AND ${common(scope)}
           AND (i."completedAt" IS NULL OR i."performedLocationId" IS NULL)
           AND ${where}
         GROUP BY 1`,
    );
    return rows.map((r) => ({
      currency: r.currency,
      count: Number(r.count),
      gross: dec(r.gross),
      discounts: dec(r.discounts),
    }));
  }

  async listItems(
    period: CivilPeriod,
    scope: ProductionScope & { catalogItemId: string; currency?: string },
    page: { skip: number; take: number },
  ): Promise<{ items: ProductionItemRow[]; total: number }> {
    const tenantId = this.requireTenantId();
    if (scope.locationIds.length === 0) return { items: [], total: 0 };
    return this.prisma.runWithTenant(async (tx) => {
      const branches = await this.branches(
        tx,
        tenantId,
        period,
        scope.locationIds,
      );
      if (branches.length === 0) return { items: [], total: 0 };
      const window = periodWindow(branches);
      const filter = Prisma.sql`
         WHERE i."tenantId" = ${tenantId}::uuid
           AND ${common(scope)}
           AND i."catalogItemId" = ${scope.catalogItemId}::uuid
           ${scope.currency !== undefined ? Prisma.sql`AND p."currency" = ${scope.currency}` : Prisma.empty}
           AND i."completedAt" >= ${utcTimestamp(window.start)}
           AND i."completedAt" < ${utcTimestamp(window.end)}
           AND ${inPeriod(Prisma.sql`i."performedLocationId"`, Prisma.sql`i."completedAt"`, branches)}`;
      const items = Prisma.sql`
          FROM "treatment_plan_items" i
          JOIN "treatment_plans" p
            ON p."tenantId" = i."tenantId" AND p."id" = i."planId"`;
      const [{ total }] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS "total" ${items} ${filter}`;
      const rows = await tx.$queryRaw<ItemRow[]>`
        SELECT i."id", i."completedAt",
               -- Un paciente eliminado no se nombra ni se enlaza.
               pt."id" AS "patientId",
               btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
               i."performedById" AS "professionalId",
               u."fullName" AS "professionalName",
               i."performedLocationId" AS "locationId",
               l."name" AS "locationName", l."timeZone",
               i."toothNumber", p."currency", i."price", i."discount"
          ${items}
          LEFT JOIN "patients" pt
            ON pt."tenantId" = i."tenantId" AND pt."id" = i."patientId"
           AND pt."deletedAt" IS NULL
          JOIN "locations" l
            ON l."tenantId" = i."tenantId" AND l."id" = i."performedLocationId"
          LEFT JOIN "users" u ON u."id" = i."performedById"
          ${filter}
         ORDER BY i."completedAt" DESC, i."id"
         OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        items: rows.map((r) => ({
          ...r,
          price: dec(r.price),
          discount: dec(r.discount),
        })),
        total: Number(total),
      };
    });
  }
}
