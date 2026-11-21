import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  loadLocationZones,
  resolveLocationTimeZones,
} from '../../../shared/locations/location-time-zone';
import { amountText } from '../../../shared/money/money';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { readFinancialLock } from '../../financial-lock/infrastructure/financial-lock-tx';
import {
  labCostOf,
  totalsByCurrency,
  type CandidateAllocation,
  type CandidateItem,
  type PlanReleaseInfo,
  type SettledLine,
  type SettlementPeriod,
} from '../domain/commission-calculator';
import type {
  CommissionCategoryPercent,
  CommissionRuleTerms,
} from '../domain/commission-rule';
import { lockDateAfterSettlement } from '../domain/settlement-period';
import { settlementPaymentState } from '../domain/settlement-payments';
import type {
  ClosedSettlement,
  CommissionProfessional,
  CommissionReader,
  CommissionRepository,
  CommissionRuleRecord,
  NewSettlement,
  UtcWindow,
} from '../domain/ports/commission-repository.port';
import type {
  CommissionLineView,
  CommissionSettlementSummary,
} from '../domain/views';

/** Roles a los que se les puede poner regla: quien realiza prestaciones. */
export const COMMISSION_PROFESSIONAL_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

const dec = (value: Prisma.Decimal | null): number => value?.toNumber() ?? 0;
const decOrNull = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : value.toNumber();
const money = (value: number): Prisma.Decimal =>
  new Prisma.Decimal(amountText(value, 2));
const civil = (value: Date): string => value.toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Lo vivo de un abono (ni anulado ni borrado). */
const LIVE_PAYMENT = Prisma.sql`py."deletedAt" IS NULL AND py."voidedAt" IS NULL`;

function categoryPercentsOf(
  value: Prisma.JsonValue,
): CommissionCategoryPercent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      return [];
    const { category, percent } = entry as Record<string, unknown>;
    return typeof category === 'string' && typeof percent === 'number'
      ? [{ category, percent }]
      : [];
  });
}

/** Lo que va a la auditoría de una regla: % y códigos, nunca importes. */
function ruleForAudit(terms: CommissionRuleTerms, active: boolean) {
  return {
    basis: terms.basis,
    releaseMode: terms.releaseMode,
    percent: terms.percent,
    categories: terms.categories.map((c) => `${c.category}: ${c.percent}`),
    deductLabCost: terms.deductLabCost,
    deductCardFee: terms.deductCardFee,
    active,
  };
}

interface CandidateRow {
  itemId: string;
  planId: string;
  patientId: string;
  locationId: string;
  code: string;
  label: string;
  category: string | null;
  toothNumber: string;
  currency: string;
  net: Prisma.Decimal;
  completedAt: Date;
  producedSettled: boolean;
  collectedSettled: boolean;
}

interface AllocationRow {
  itemId: string;
  paymentId: string;
  amount: Prisma.Decimal;
  paidAt: Date;
  paymentAmount: Prisma.Decimal;
  paymentCurrency: string;
  gatewayFeePercent: Prisma.Decimal | null;
}

interface LabCostRow {
  itemId: string;
  cost: Prisma.Decimal;
  currency: string;
}

interface PlanReleaseRow {
  planId: string;
  pendingItems: bigint;
  doneItems: bigint;
  unpaidDoneItems: bigint;
  lastCompletedAt: Date | null;
  lastPaidAt: Date | null;
}

interface SettledRow {
  lineId: string;
  itemId: string;
  planId: string;
  patientId: string;
  paymentId: string | null;
  locationId: string | null;
  catalogCode: string;
  catalogLabel: string;
  category: string | null;
  toothNumber: string;
  completedAt: Date | null;
  paidAt: Date | null;
  paymentAmount: Prisma.Decimal | null;
  paymentCurrency: string | null;
  currency: string;
  percent: Prisma.Decimal;
  settledBase: Prisma.Decimal;
  settledAmount: Prisma.Decimal;
  settledGross: Prisma.Decimal;
  settledLabCost: Prisma.Decimal;
  settledCardFee: Prisma.Decimal;
  originalGross: Prisma.Decimal;
  originalLabCost: Prisma.Decimal;
  cardFeePercent: Prisma.Decimal | null;
  currentGross: Prisma.Decimal;
}

/**
 * DX-018: lecturas de la liquidación de un profesional con la transacción de
 * quien la pide (vista previa: foto REPEATABLE READ; cierre: la del candado).
 * La atribución es la de DX-050/DX-423 (quien realizó el ítem, por su
 * membresía) y lo cobrado son las imputaciones de DX-051.
 */
class PrismaCommissionReader implements CommissionReader {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly tenantId: string,
    private readonly tenantContext: TenantContextService,
  ) {}

  async rule(membershipId: string): Promise<CommissionRuleRecord | null> {
    return readRule(this.tx, this.tenantId, membershipId);
  }

  async candidates(
    professional: CommissionProfessional,
    terms: CommissionRuleTerms,
    window: UtcWindow,
  ): Promise<CandidateItem[]> {
    const { tx, tenantId } = this;
    const userId = professional.userId;
    const perItemProduced =
      terms.basis === 'PRODUCED' && terms.releaseMode === 'PER_ITEM';
    // Cota inferior: algo del ítem (PER_ITEM) o de su plan (PER_PLAN) pasó
    // dentro de la ventana; si no, no puede liberarse en el período.
    const recent =
      terms.releaseMode === 'PER_PLAN'
        ? Prisma.sql`(
            EXISTS (SELECT 1 FROM "treatment_plan_items" i2
                     WHERE i2."tenantId" = i."tenantId" AND i2."planId" = i."planId"
                       AND i2."deletedAt" IS NULL AND i2."status" = 'DONE'
                       AND i2."completedAt" >= ${window.start})
            OR EXISTS (SELECT 1 FROM "payment_allocations" a
                         JOIN "payments" py ON py."tenantId" = a."tenantId" AND py."id" = a."paymentId"
                        WHERE a."tenantId" = i."tenantId" AND a."treatmentPlanId" = i."planId"
                          AND ${LIVE_PAYMENT} AND py."paidAt" >= ${window.start}))`
        : perItemProduced
          ? Prisma.sql`i."completedAt" >= ${window.start}`
          : Prisma.sql`(
            i."completedAt" >= ${window.start}
            OR EXISTS (SELECT 1 FROM "payment_allocations" a
                         JOIN "payments" py ON py."tenantId" = a."tenantId" AND py."id" = a."paymentId"
                        WHERE a."tenantId" = i."tenantId" AND a."treatmentPlanItemId" = i."id"
                          AND ${LIVE_PAYMENT} AND py."paidAt" >= ${window.start}))`;
    const rows = await tx.$queryRaw<CandidateRow[]>`
      SELECT i."id" AS "itemId", i."planId", i."patientId",
             i."performedLocationId" AS "locationId",
             c."code", c."labelEs" AS "label",
             NULLIF(btrim(c."category"), '') AS "category",
             i."toothNumber", p."currency",
             (i."price" - i."discount") AS "net", i."completedAt",
             EXISTS (SELECT 1 FROM "commission_settlement_lines" l
                      WHERE l."tenantId" = i."tenantId" AND l."userId" = ${userId}::uuid
                        AND l."treatmentPlanItemId" = i."id" AND l."kind" = 'ACCRUAL'
                        AND l."paymentId" IS NULL) AS "producedSettled",
             EXISTS (SELECT 1 FROM "commission_settlement_lines" l
                      WHERE l."tenantId" = i."tenantId" AND l."userId" = ${userId}::uuid
                        AND l."treatmentPlanItemId" = i."id" AND l."kind" = 'ACCRUAL'
                        AND l."paymentId" IS NOT NULL) AS "collectedSettled"
        FROM "treatment_plan_items" i
        JOIN "treatment_plans" p ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
        JOIN "dental_catalog_items" c ON c."tenantId" = i."tenantId" AND c."id" = i."catalogItemId"
       WHERE i."tenantId" = ${tenantId}::uuid
         AND i."performedById" = ${userId}::uuid
         AND i."performedByMembershipId" = ${professional.membershipId}::uuid
         AND i."status" = 'DONE'
         AND i."deletedAt" IS NULL
         AND p."deletedAt" IS NULL
         AND i."completedAt" IS NOT NULL
         AND i."performedLocationId" IS NOT NULL
         AND i."completedAt" < ${window.end}
         AND ${recent}`;
    const pending = rows.filter((r) =>
      terms.basis === 'PRODUCED'
        ? !r.producedSettled && !r.collectedSettled
        : !r.producedSettled,
    );
    if (pending.length === 0) return [];
    const zoneOf = await this.zones(pending.map((r) => r.locationId));
    const allocations = new Map<string, CandidateAllocation[]>();
    if (terms.basis === 'COLLECTED') {
      const allocationRows = await tx.$queryRaw<AllocationRow[]>`
        SELECT a."treatmentPlanItemId" AS "itemId", a."paymentId", a."amount",
               py."paidAt", py."amount" AS "paymentAmount", py."currency" AS "paymentCurrency",
               pm."gatewayFeePercent"
          FROM "payment_allocations" a
          JOIN "payments" py ON py."tenantId" = a."tenantId" AND py."id" = a."paymentId"
          LEFT JOIN "payment_methods" pm
            ON pm."tenantId" = py."tenantId" AND pm."id" = py."paymentMethodId"
         WHERE a."tenantId" = ${tenantId}::uuid
           AND a."treatmentPlanItemId" = ANY(${pending.map((r) => r.itemId)}::uuid[])
           AND a."amount" > 0
           AND ${LIVE_PAYMENT}
           AND py."paidAt" < ${window.end}
           AND NOT EXISTS (
             SELECT 1 FROM "commission_settlement_lines" l
              WHERE l."tenantId" = a."tenantId" AND l."userId" = ${userId}::uuid
                AND l."treatmentPlanItemId" = a."treatmentPlanItemId"
                AND l."paymentId" = a."paymentId" AND l."kind" = 'ACCRUAL')`;
      for (const row of allocationRows) {
        const list = allocations.get(row.itemId) ?? [];
        list.push({
          paymentId: row.paymentId,
          amount: dec(row.amount),
          paidAt: row.paidAt,
          paymentAmount: dec(row.paymentAmount),
          paymentCurrency: row.paymentCurrency,
          // DX-018-bis: el % de la pasarela del medio, hoy (se congela al cerrar).
          cardFeePercent: decOrNull(row.gatewayFeePercent),
        });
        allocations.set(row.itemId, list);
      }
    }
    const labCosts = terms.deductLabCost
      ? await this.labCosts(pending)
      : new Map<string, { amount: number; currency: string }[]>();
    return pending.map((r) => {
      const lab = labCostOf(r.currency, labCosts.get(r.itemId) ?? []);
      return {
        itemId: r.itemId,
        planId: r.planId,
        patientId: r.patientId,
        locationId: r.locationId,
        timeZone: zoneOf(r.locationId),
        catalogCode: r.code,
        catalogLabel: r.label,
        category: r.category,
        toothNumber: r.toothNumber,
        currency: r.currency,
        net: dec(r.net),
        completedAt: r.completedAt,
        producedPending: !r.producedSettled && !r.collectedSettled,
        allocations: allocations.get(r.itemId) ?? [],
        labCost: lab.labCost,
        labCostSkippedCurrencies: lab.skippedCurrencies,
      };
    });
  }

  /**
   * DX-018-bis: los costos de las órdenes de laboratorio vivas (no anuladas)
   * ligadas a cada ítem. Por (paciente, ítem): el índice
   * dental_lab_orders_plan_item_idx.
   */
  private async labCosts(
    items: readonly Pick<CandidateRow, 'itemId' | 'patientId'>[],
  ): Promise<Map<string, { amount: number; currency: string }[]>> {
    const rows = await this.tx.$queryRaw<LabCostRow[]>`
      SELECT o."treatmentPlanItemId" AS "itemId", o."cost", o."costCurrency" AS "currency"
        FROM unnest(${items.map((i) => i.patientId)}::uuid[], ${items.map((i) => i.itemId)}::uuid[]) AS k("patientId", "itemId")
        JOIN "dental_lab_orders" o
          ON o."tenantId" = ${this.tenantId}::uuid
         AND o."patientId" = k."patientId" AND o."treatmentPlanItemId" = k."itemId"
       WHERE o."cancelledAt" IS NULL AND o."cost" IS NOT NULL
       ORDER BY o."number"`;
    const out = new Map<string, { amount: number; currency: string }[]>();
    for (const row of rows) {
      const list = out.get(row.itemId) ?? [];
      list.push({ amount: dec(row.cost), currency: row.currency });
      out.set(row.itemId, list);
    }
    return out;
  }

  async planRelease(planIds: readonly string[]): Promise<PlanReleaseInfo[]> {
    const ids = [...new Set(planIds)];
    if (ids.length === 0) return [];
    const rows = await this.tx.$queryRaw<PlanReleaseRow[]>`
      SELECT i."planId",
             count(*) FILTER (WHERE i."status" = 'ACCEPTED') AS "pendingItems",
             count(*) FILTER (WHERE i."status" = 'DONE') AS "doneItems",
             count(*) FILTER (
               WHERE i."status" = 'DONE'
                 AND COALESCE(paid."amount", 0) < (i."price" - i."discount")
             ) AS "unpaidDoneItems",
             max(i."completedAt") FILTER (WHERE i."status" = 'DONE') AS "lastCompletedAt",
             max(paid."lastPaidAt") AS "lastPaidAt"
        FROM "treatment_plan_items" i
        LEFT JOIN LATERAL (
          SELECT sum(a."amount") AS "amount", max(py."paidAt") AS "lastPaidAt"
            FROM "payment_allocations" a
            JOIN "payments" py ON py."tenantId" = a."tenantId" AND py."id" = a."paymentId"
           WHERE a."tenantId" = i."tenantId" AND a."treatmentPlanItemId" = i."id"
             AND ${LIVE_PAYMENT}
        ) paid ON true
       WHERE i."tenantId" = ${this.tenantId}::uuid
         AND i."planId" = ANY(${ids}::uuid[])
         AND i."deletedAt" IS NULL
       GROUP BY i."planId"`;
    return rows.map((r) => ({
      planId: r.planId,
      pendingItems: Number(r.pendingItems),
      doneItems: Number(r.doneItems),
      unpaidDoneItems: Number(r.unpaidDoneItems),
      lastCompletedAt: r.lastCompletedAt,
      lastPaidAt: r.lastPaidAt,
    }));
  }

  async settledToAdjust(
    professional: CommissionProfessional,
  ): Promise<SettledLine[]> {
    const userId = professional.userId;
    const rows = await this.tx.$queryRaw<SettledRow[]>`
      SELECT * FROM (
        SELECT l."id" AS "lineId", l."treatmentPlanItemId" AS "itemId",
               l."treatmentPlanId" AS "planId", i."patientId", l."paymentId",
               l."locationId", l."catalogCode", l."catalogLabel", l."category",
               l."toothNumber", l."completedAt", l."paidAt", l."paymentAmount",
               l."paymentCurrency", l."currency", l."percent",
               l."base" + COALESCE(adj."base", 0) AS "settledBase",
               l."amount" + COALESCE(adj."amount", 0) AS "settledAmount",
               COALESCE(l."grossBase", l."base") + COALESCE(adj."gross", 0) AS "settledGross",
               l."labCostDeducted" + COALESCE(adj."labCost", 0) AS "settledLabCost",
               l."cardFeeDeducted" + COALESCE(adj."cardFee", 0) AS "settledCardFee",
               COALESCE(l."grossBase", l."base") AS "originalGross",
               l."labCostDeducted" AS "originalLabCost",
               l."cardFeePercent",
               CASE
                 WHEN i."status" <> 'DONE' OR i."deletedAt" IS NOT NULL
                      OR p."deletedAt" IS NOT NULL
                      OR i."performedById" IS DISTINCT FROM ${userId}::uuid THEN 0
                 WHEN l."paymentId" IS NULL THEN i."price" - i."discount"
                 ELSE COALESCE(cur."amount", 0)
               END AS "currentGross"
          FROM "commission_settlement_lines" l
          JOIN "treatment_plan_items" i
            ON i."tenantId" = l."tenantId" AND i."id" = l."treatmentPlanItemId"
          JOIN "treatment_plans" p ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
          LEFT JOIN LATERAL (
            SELECT sum(x."base") AS "base", sum(x."amount") AS "amount",
                   sum(COALESCE(x."grossBase", x."base")) AS "gross",
                   sum(x."labCostDeducted") AS "labCost",
                   sum(x."cardFeeDeducted") AS "cardFee"
              FROM "commission_settlement_lines" x
             WHERE x."tenantId" = l."tenantId" AND x."adjustsLineId" = l."id"
          ) adj ON true
          LEFT JOIN LATERAL (
            SELECT a."amount"
              FROM "payment_allocations" a
              JOIN "payments" py ON py."tenantId" = a."tenantId" AND py."id" = a."paymentId"
             WHERE a."tenantId" = l."tenantId" AND a."paymentId" = l."paymentId"
               AND a."treatmentPlanItemId" = l."treatmentPlanItemId"
               AND ${LIVE_PAYMENT}
          ) cur ON l."paymentId" IS NOT NULL
         WHERE l."tenantId" = ${this.tenantId}::uuid
           AND l."userId" = ${userId}::uuid
           AND l."kind" = 'ACCRUAL'
      ) s
      -- DX-018-bis: solo lo que cambió de base BRUTA; los descuentos quedan
      -- congelados (cambiar el costo o el % después no ajusta lo liquidado).
      WHERE s."settledGross" <> s."currentGross"
      ORDER BY s."lineId"`;
    return rows.map((r) => ({
      lineId: r.lineId,
      itemId: r.itemId,
      planId: r.planId,
      patientId: r.patientId,
      paymentId: r.paymentId,
      locationId: r.locationId,
      catalogCode: r.catalogCode,
      catalogLabel: r.catalogLabel,
      category: r.category,
      toothNumber: r.toothNumber,
      completedAt: r.completedAt,
      paidAt: r.paidAt,
      paymentAmount: decOrNull(r.paymentAmount),
      paymentCurrency: r.paymentCurrency,
      currency: r.currency,
      percent: dec(r.percent),
      settledBase: dec(r.settledBase),
      settledAmount: dec(r.settledAmount),
      settledGross: dec(r.settledGross),
      settledLabCost: dec(r.settledLabCost),
      settledCardFee: dec(r.settledCardFee),
      originalGross: dec(r.originalGross),
      originalLabCost: dec(r.originalLabCost),
      cardFeePercent: decOrNull(r.cardFeePercent),
      currentGross: dec(r.currentGross),
    }));
  }

  async lastClosedTo(membershipId: string): Promise<string | null> {
    const last = await this.tx.commissionSettlement.findFirst({
      where: { tenantId: this.tenantId, membershipId },
      orderBy: { periodTo: 'desc' },
      select: { periodTo: true },
    });
    return last ? civil(last.periodTo) : null;
  }

  async overlaps(
    membershipId: string,
    period: SettlementPeriod,
  ): Promise<boolean> {
    const found = await this.tx.commissionSettlement.findFirst({
      where: {
        tenantId: this.tenantId,
        membershipId,
        periodFrom: { lte: asDate(period.to) },
        periodTo: { gte: asDate(period.from) },
      },
      select: { id: true },
    });
    return found !== null;
  }

  async patientNames(
    patientIds: readonly string[],
  ): Promise<Map<string, string>> {
    return readPatientNames(this.tx, this.tenantId, patientIds);
  }

  async zones(
    locationIds: readonly string[],
  ): Promise<(locationId: string) => string> {
    const zones = await loadLocationZones(this.tx, this.tenantId, locationIds);
    return (locationId) => zones.zoneOf(locationId);
  }

  async today(now: Date): Promise<string> {
    const locationId = await this.tenantContext.writeLocationId(this.tx);
    const zoneOf = await resolveLocationTimeZones(this.tx, this.tenantId, [
      locationId,
    ]);
    return civilDateIn(now, zoneOf(locationId));
  }
}

async function readRule(
  tx: Prisma.TransactionClient,
  tenantId: string,
  membershipId: string,
): Promise<CommissionRuleRecord | null> {
  const row = await tx.commissionRule.findUnique({
    where: { tenantId_membershipId: { tenantId, membershipId } },
    include: { categories: { orderBy: { category: 'asc' } } },
  });
  return row ? ruleRecordOf(row) : null;
}

function ruleRecordOf(
  row: Prisma.CommissionRuleGetPayload<{ include: { categories: true } }>,
): CommissionRuleRecord {
  return {
    id: row.id,
    active: row.active,
    updatedAt: row.updatedAt,
    terms: {
      basis: row.basis,
      releaseMode: row.releaseMode,
      percent: dec(row.percent),
      categories: row.categories.map((c) => ({
        category: c.category,
        percent: dec(c.percent),
      })),
      deductLabCost: row.deductLabCost,
      deductCardFee: row.deductCardFee,
    },
  };
}

async function readPatientNames(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(patientIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT pt."id", btrim(pt."firstName" || ' ' || pt."lastName") AS "name"
      FROM "patients" pt
     WHERE pt."tenantId" = ${tenantId}::uuid AND pt."id" = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** DX-464: las líneas con el pago vivo que las cubre (para el estado de pago). */
const SETTLEMENT_LINES_SELECT = {
  select: {
    id: true,
    kind: true,
    currency: true,
    amount: true,
    paymentLines: {
      where: { voidedAt: null },
      select: { paymentId: true },
    },
  },
} satisfies Prisma.CommissionSettlement$linesArgs;

type SettlementRow = Prisma.CommissionSettlementGetPayload<{
  include: { lines: typeof SETTLEMENT_LINES_SELECT };
}>;

@Injectable()
export class PrismaCommissionRepository implements CommissionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listProfessionals(): Promise<
    {
      professional: CommissionProfessional;
      rule: CommissionRuleRecord | null;
    }[]
  > {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rules = await tx.commissionRule.findMany({
        where: { tenantId },
        include: { categories: { orderBy: { category: 'asc' } } },
      });
      const ruleByMembership = new Map(rules.map((r) => [r.membershipId, r]));
      const members = await tx.clinicMembership.findMany({
        where: {
          tenantId,
          OR: [
            {
              deletedAt: null,
              role: { in: [...COMMISSION_PROFESSIONAL_ROLES] },
            },
            { id: { in: rules.map((r) => r.membershipId) } },
          ],
        },
        select: {
          id: true,
          userId: true,
          role: true,
          deletedAt: true,
          user: { select: { fullName: true } },
        },
      });
      return members
        .map((m) => {
          const rule = ruleByMembership.get(m.id);
          return {
            professional: {
              membershipId: m.id,
              userId: m.userId,
              name: m.user.fullName,
              role: m.role,
              active: m.deletedAt === null,
            },
            rule: rule ? ruleRecordOf(rule) : null,
          };
        })
        .sort((a, b) =>
          a.professional.name.localeCompare(b.professional.name, 'es', {
            sensitivity: 'base',
          }),
        );
    });
  }

  async listCategories(): Promise<string[]> {
    const tenantId = this.tenantId();
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
    return [
      ...new Set(
        rows.map((r) => r.category?.trim() ?? '').filter((c) => c !== ''),
      ),
    ].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  }

  async findProfessional(
    userId: string,
  ): Promise<CommissionProfessional | null> {
    const tenantId = this.tenantId();
    const m = await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.findFirst({
        where: { tenantId, userId },
        select: {
          id: true,
          userId: true,
          role: true,
          deletedAt: true,
          user: { select: { fullName: true } },
        },
      }),
    );
    if (!m) return null;
    return {
      membershipId: m.id,
      userId: m.userId,
      name: m.user.fullName,
      role: m.role,
      active: m.deletedAt === null,
    };
  }

  async saveRule(
    professional: CommissionProfessional,
    terms: CommissionRuleTerms,
    active: boolean,
    ctx: AuditRequestContext,
  ): Promise<CommissionRuleRecord> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Dos guardados simultáneos de la misma regla se ordenan y cada uno
      // audita su antes real.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission_rule:${tenantId}:${professional.membershipId}`}, 0))`;
      const before = await readRule(tx, tenantId, professional.membershipId);
      const actor = ctx.actor.userId;
      const data = {
        basis: terms.basis,
        releaseMode: terms.releaseMode,
        percent: new Prisma.Decimal(terms.percent),
        deductLabCost: terms.deductLabCost,
        deductCardFee: terms.deductCardFee,
        active,
        updatedById: actor,
      };
      const rule = before
        ? await tx.commissionRule.update({
            where: { id: before.id },
            data,
            select: { id: true },
          })
        : await tx.commissionRule.create({
            data: {
              ...data,
              id: randomUUID(),
              tenantId,
              membershipId: professional.membershipId,
              userId: professional.userId,
              createdById: actor,
            },
            select: { id: true },
          });
      // eslint-disable-next-line no-restricted-syntax -- los % por categoría son configuración de la regla y se sustituyen al guardarla (HARD_DELETE_ALLOWLIST, auditado).
      await tx.commissionRuleCategory.deleteMany({
        where: { tenantId, ruleId: rule.id },
      });
      if (terms.categories.length > 0) {
        await tx.commissionRuleCategory.createMany({
          data: terms.categories.map((c) => ({
            id: randomUUID(),
            tenantId,
            ruleId: rule.id,
            category: c.category,
            percent: new Prisma.Decimal(c.percent),
          })),
        });
      }
      const after = await readRule(tx, tenantId, professional.membershipId);
      if (!after) throw new Error('commission rule vanished');
      const event = before
        ? configAuditEvent(ctx, {
            action: 'UPDATE',
            resourceType: 'CLINIC_SETTINGS',
            resourceId: after.id,
            reason: 'COMMISSION_RULE',
            before: ruleForAudit(before.terms, before.active),
            after: ruleForAudit(after.terms, after.active),
            extra: { params: { userId: professional.userId } },
          })
        : configAuditEvent(ctx, {
            action: 'CREATE',
            resourceType: 'CLINIC_SETTINGS',
            resourceId: after.id,
            reason: 'COMMISSION_RULE',
            after: ruleForAudit(after.terms, after.active),
            extra: { params: { userId: professional.userId } },
          });
      if (event) await writeAuditEvent(tx, event);
      return after;
    });
  }

  read<T>(fn: (reader: CommissionReader) => Promise<T>): Promise<T> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(
      (tx) => fn(new PrismaCommissionReader(tx, tenantId, this.tenantContext)),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  close(
    membershipId: string,
    prepare: (reader: CommissionReader) => Promise<NewSettlement>,
    ctx: AuditRequestContext,
  ): Promise<ClosedSettlement> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Un cierre a la vez por profesional: el segundo espera y ve el primero.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission_settlement:${tenantId}:${membershipId}`}, 0))`;
      const settlement = await prepare(
        new PrismaCommissionReader(tx, tenantId, this.tenantContext),
      );
      // El cierre contable (DX-091) con la fila de la clínica bloqueada, como
      // Ajustes › Caja › Cierre contable.
      await tx.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      const lockBefore = await readFinancialLock(tx, tenantId);
      const lockDateAfter = lockDateAfterSettlement(
        lockBefore.lockDate,
        settlement.period.to,
      );
      const id = randomUUID();
      try {
        await tx.commissionSettlement.create({
          data: {
            id,
            tenantId,
            membershipId,
            userId: settlement.professional.userId,
            periodFrom: asDate(settlement.period.from),
            periodTo: asDate(settlement.period.to),
            basis: settlement.terms.basis,
            releaseMode: settlement.terms.releaseMode,
            percent: new Prisma.Decimal(settlement.terms.percent),
            categoryPercents: settlement.terms.categories.map((c) => ({
              category: c.category,
              percent: c.percent,
            })),
            deductLabCost: settlement.terms.deductLabCost,
            deductCardFee: settlement.terms.deductCardFee,
            lockDateBefore:
              lockBefore.lockDate === null ? null : asDate(lockBefore.lockDate),
            lockDateAfter: asDate(lockDateAfter),
            closedById: ctx.actor.userId,
          },
          select: { id: true },
        });
      } catch (error) {
        if (isExclusionViolation(error)) throw overlapConflict();
        throw error;
      }
      // Ids fijados antes de insertar: un ajuste del mismo cierre nunca
      // apunta a una línea de este cierre (solo a cerradas).
      if (settlement.lines.length > 0) {
        await tx.commissionSettlementLine.createMany({
          data: settlement.lines.map((line) => ({
            id: randomUUID(),
            tenantId,
            settlementId: id,
            userId: settlement.professional.userId,
            kind: line.kind,
            adjustsLineId: line.adjustsLineId,
            treatmentPlanId: line.planId,
            treatmentPlanItemId: line.itemId,
            paymentId: line.paymentId,
            locationId: line.locationId,
            catalogCode: line.catalogCode,
            catalogLabel: line.catalogLabel,
            category: line.category,
            toothNumber: line.toothNumber,
            completedAt: line.completedAt,
            paidAt: line.paidAt,
            paymentAmount:
              line.paymentAmount === null ? null : money(line.paymentAmount),
            paymentCurrency: line.paymentCurrency,
            releasedAt: line.releasedAt,
            currency: line.currency,
            base: money(line.base),
            percent: new Prisma.Decimal(line.percent),
            amount: money(line.amount),
            grossBase: money(line.grossBase),
            labCostDeducted: money(line.labCostDeducted),
            cardFeePercent:
              line.cardFeePercent === null
                ? null
                : new Prisma.Decimal(line.cardFeePercent),
            cardFeeDeducted: money(line.cardFeeDeducted),
            labCostSkippedCurrencies: line.labCostSkippedCurrencies,
          })),
        });
      }
      if (lockDateAfter !== lockBefore.lockDate) {
        await tx.tenant.update({
          where: { id: tenantId },
          data: { financialLockDate: asDate(lockDateAfter) },
          select: { id: true },
        });
        const lockEvent = configAuditEvent(ctx, {
          action: 'UPDATE',
          resourceType: 'CLINIC_SETTINGS',
          resourceId: tenantId,
          reason: 'FINANCIAL_LOCK',
          before: { financialLockDate: lockBefore.lockDate },
          after: { financialLockDate: lockDateAfter },
          extra: { params: { settlementId: id } },
        });
        if (lockEvent) await writeAuditEvent(tx, lockEvent);
      }
      // Sin importes: período, profesional y cuántas líneas.
      await writeAuditEvent(
        tx,
        configAuditEvent(ctx, {
          action: 'CREATE',
          resourceType: 'COMMISSION_SETTLEMENT',
          resourceId: id,
          reason: 'COMMISSION_SETTLEMENT_CLOSED',
          after: {
            periodFrom: settlement.period.from,
            periodTo: settlement.period.to,
            basis: settlement.terms.basis,
            releaseMode: settlement.terms.releaseMode,
            lines: settlement.lines.length,
          },
          extra: { params: { userId: settlement.professional.userId } },
        }),
      );
      return {
        id,
        lockDateBefore: lockBefore.lockDate,
        lockDateAfter,
      };
    });
  }

  async listSettlements(filter: {
    userId?: string;
    limit: number;
  }): Promise<CommissionSettlementSummary[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.commissionSettlement.findMany({
        where: {
          tenantId,
          ...(filter.userId !== undefined ? { userId: filter.userId } : {}),
        },
        orderBy: [{ periodTo: 'desc' }, { closedAt: 'desc' }],
        take: filter.limit,
        include: { lines: SETTLEMENT_LINES_SELECT },
      });
      return this.summaries(tx, tenantId, rows);
    });
  }

  async getSettlement(id: string): Promise<{
    summary: CommissionSettlementSummary;
    categoryPercents: CommissionCategoryPercent[];
    lines: CommissionLineView[];
  } | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.commissionSettlement.findFirst({
        where: { tenantId, id },
        include: { lines: SETTLEMENT_LINES_SELECT },
      });
      if (!row) return null;
      const [summary] = await this.summaries(tx, tenantId, [row]);
      const lines = await tx.$queryRaw<
        {
          id: string;
          kind: 'ACCRUAL' | 'ADJUSTMENT';
          adjustsLineId: string | null;
          patientId: string;
          patientName: string | null;
          treatmentPlanId: string;
          treatmentPlanItemId: string;
          locationId: string | null;
          catalogCode: string;
          catalogLabel: string;
          category: string | null;
          toothNumber: string;
          completedAt: Date | null;
          paymentId: string | null;
          paidAt: Date | null;
          paymentAmount: Prisma.Decimal | null;
          paymentCurrency: string | null;
          releasedAt: Date | null;
          currency: string;
          base: Prisma.Decimal;
          percent: Prisma.Decimal;
          amount: Prisma.Decimal;
          grossBase: Prisma.Decimal;
          labCostDeducted: Prisma.Decimal;
          cardFeePercent: Prisma.Decimal | null;
          cardFeeDeducted: Prisma.Decimal;
          labCostSkippedCurrencies: string[];
          paidInPaymentId: string | null;
        }[]
      >`
        SELECT l."id", l."kind", l."adjustsLineId", i."patientId",
               btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
               l."treatmentPlanId", l."treatmentPlanItemId", l."locationId", l."catalogCode",
               l."catalogLabel", l."category", l."toothNumber", l."completedAt",
               l."paymentId", l."paidAt", l."paymentAmount", l."paymentCurrency",
               l."releasedAt", l."currency", l."base", l."percent", l."amount",
               COALESCE(l."grossBase", l."base") AS "grossBase", l."labCostDeducted",
               l."cardFeePercent", l."cardFeeDeducted", l."labCostSkippedCurrencies",
               (SELECT cpl."paymentId" FROM "commission_payment_lines" cpl
                 WHERE cpl."tenantId" = l."tenantId" AND cpl."lineId" = l."id"
                   AND cpl."voidedAt" IS NULL) AS "paidInPaymentId"
          FROM "commission_settlement_lines" l
          JOIN "treatment_plan_items" i
            ON i."tenantId" = l."tenantId" AND i."id" = l."treatmentPlanItemId"
          LEFT JOIN "patients" pt ON pt."tenantId" = i."tenantId" AND pt."id" = i."patientId"
         WHERE l."tenantId" = ${tenantId}::uuid AND l."settlementId" = ${id}::uuid
         ORDER BY l."kind", l."releasedAt" NULLS LAST, l."catalogCode", l."id"`;
      return {
        summary,
        categoryPercents: categoryPercentsOf(row.categoryPercents),
        lines: lines.map((l) => ({
          id: l.id,
          kind: l.kind,
          adjustsLineId: l.adjustsLineId,
          patient: { id: l.patientId, name: l.patientName },
          treatmentPlanId: l.treatmentPlanId,
          treatmentPlanItemId: l.treatmentPlanItemId,
          locationId: l.locationId,
          catalogCode: l.catalogCode,
          catalogLabel: l.catalogLabel,
          category: l.category,
          toothNumber: l.toothNumber,
          completedAt: l.completedAt,
          payment:
            l.paymentId !== null &&
            l.paidAt !== null &&
            l.paymentCurrency !== null
              ? {
                  id: l.paymentId,
                  paidAt: l.paidAt,
                  amount: dec(l.paymentAmount),
                  currency: l.paymentCurrency,
                }
              : null,
          releasedAt: l.releasedAt,
          currency: l.currency,
          base: dec(l.base),
          percent: dec(l.percent),
          amount: dec(l.amount),
          deductions: {
            grossBase: dec(l.grossBase),
            labCost: dec(l.labCostDeducted),
            cardFeePercent: decOrNull(l.cardFeePercent),
            cardFee: dec(l.cardFeeDeducted),
            labCostSkippedCurrencies: l.labCostSkippedCurrencies,
          },
          paidInPaymentId: l.paidInPaymentId,
        })),
      };
    });
  }

  private async summaries(
    tx: Prisma.TransactionClient,
    tenantId: string,
    rows: SettlementRow[],
  ): Promise<CommissionSettlementSummary[]> {
    const userIds = [...new Set(rows.flatMap((r) => [r.userId, r.closedById]))];
    const members =
      userIds.length === 0
        ? []
        : await tx.clinicMembership.findMany({
            where: { tenantId, userId: { in: userIds } },
            select: {
              id: true,
              userId: true,
              role: true,
              deletedAt: true,
              user: { select: { fullName: true } },
            },
          });
    const byUser = new Map(members.map((m) => [m.userId, m]));
    return rows.map((r) => {
      const member = byUser.get(r.userId);
      return {
        id: r.id,
        professional: {
          userId: r.userId,
          membershipId: r.membershipId,
          name: member?.user.fullName ?? '',
          role: member?.role ?? ClinicRole.DENTIST,
          active: member !== undefined && member.deletedAt === null,
        },
        period: { from: civil(r.periodFrom), to: civil(r.periodTo) },
        basis: r.basis,
        releaseMode: r.releaseMode,
        percent: dec(r.percent),
        deductLabCost: r.deductLabCost,
        deductCardFee: r.deductCardFee,
        closedAt: r.closedAt,
        closedBy: {
          userId: r.closedById,
          name: byUser.get(r.closedById)?.user.fullName ?? null,
        },
        lockDateBefore: r.lockDateBefore ? civil(r.lockDateBefore) : null,
        lockDateAfter: civil(r.lockDateAfter),
        totals: totalsByCurrency(
          r.lines.map((l) => ({
            kind: l.kind,
            currency: l.currency,
            amount: dec(l.amount),
          })),
        ),
        payment: settlementPaymentState(
          r.lines.map((l) => ({
            id: l.id,
            currency: l.currency,
            amount: dec(l.amount),
            paymentId: l.paymentLines[0]?.paymentId ?? null,
          })),
        ),
      };
    });
  }
}

/** 23P01: la EXCLUDE de commission_settlements (otra cerrada solapa). */
function isExclusionViolation(error: unknown): boolean {
  const text = error instanceof Error ? error.message : '';
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.meta?.code
      : undefined;
  return code === '23P01' || text.includes('commission_settlements_no_overlap');
}

export function overlapConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'COMMISSION_PERIOD_OVERLAP',
    message:
      'El período se solapa con una liquidación ya cerrada de este profesional.',
  });
}
