import { Injectable } from '@nestjs/common';
import {
  PaymentAllocationSource,
  Prisma,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { isPlanBillable } from '../../../treatment-plans/domain/plan-status-machine';
import {
  itemBillableCents,
  type AllocatableItem,
  type AllocationIncrement,
  type Donor,
} from '../../domain/allocation-rules';
import type {
  PaymentWithoutBase,
  PlanAllocationRepository,
  PlanAllocationSnapshot,
  RebalanceOptions,
} from '../../domain/ports/plan-allocation-repository.port';

const toCents = (value: Prisma.Decimal | number): number =>
  Math.round(Number(value) * 100);

const fromCents = (cents: number): Prisma.Decimal =>
  new Prisma.Decimal(cents).dividedBy(100);

/**
 * Encola el plan para el reparto (spec §3.3): INSERT simple, sin ON CONFLICT
 * ni esperas; varias filas por plan son normales. Va en la transacción de la
 * escritura que deja saldo por repartir (alta con base, anulación, base
 * creada por el barrido).
 */
export async function enqueuePlanRebalance(
  tx: Prisma.TransactionClient,
  tenantId: string,
  planId: string,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "plan_allocation_rebalance_requests" ("tenantId", "treatmentPlanId")
    VALUES (${tenantId}::uuid, ${planId}::uuid)`;
}

/** Centinela de `dryRun`: lanzarlo dentro de la transacción la deshace. */
class DryRunRollback extends Error {
  constructor(readonly allocatedCents: number) {
    super('dry-run');
  }
}

/**
 * Persistencia del reparto automático (DX-051). Orden de bloqueo de R6 en
 * todo escritor: plan FOR SHARE → bases FOR UPDATE ORDER BY "paymentId" →
 * ítems FOR UPDATE ORDER BY id → liveness de donantes y sumas en sentencias
 * POSTERIORES (en READ COMMITTED cada sentencia ve lo confirmado hasta su
 * inicio; EvalPlanQual no relee las tablas unidas a la que bloquea).
 */
@Injectable()
export class PrismaPlanAllocationRepository implements PlanAllocationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async rebalance(
    planId: string,
    options: RebalanceOptions,
    decide: (snapshot: PlanAllocationSnapshot) => AllocationIncrement[],
  ): Promise<number> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // 1. Las solicitudes del plan que este drenador se queda. SKIP LOCKED
        // solo reparte el trabajo entre drenadores; las que inserte después
        // una transacción aún abierta sobreviven al DELETE final (solo borra
        // las vistas) y el plan se vuelve a repartir.
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id"::text AS "id" FROM "plan_allocation_rebalance_requests"
           WHERE "tenantId" = ${tenantId}::uuid
             AND "treatmentPlanId" = ${planId}::uuid
           ORDER BY "id"
             FOR UPDATE SKIP LOCKED`;
        // Otro drenador tiene todas las del plan: el reparto es suyo.
        if (options.onlyIfRequested && claimed.length === 0) return 0;
        const seen = claimed.map((r) => r.id);

        const allocated = await this.spread(
          tx,
          tenantId,
          planId,
          options.actorId,
          decide,
        );
        await tx.$executeRaw`
          DELETE FROM "plan_allocation_rebalance_requests"
           WHERE "tenantId" = ${tenantId}::uuid
             AND "id" = ANY(${seen}::bigint[])`;
        if (options.dryRun) throw new DryRunRollback(allocated);
        return allocated;
      });
    } catch (error) {
      if (error instanceof DryRunRollback) return error.allocatedCents;
      throw error;
    }
  }

  /** Bloqueos de R6, foto posterior, `decide` y escritura AUTO. */
  private async spread(
    tx: Prisma.TransactionClient,
    tenantId: string,
    planId: string,
    actorId: string | null,
    decide: (snapshot: PlanAllocationSnapshot) => AllocationIncrement[],
  ): Promise<number> {
    const [plan] = await tx.$queryRaw<
      {
        status: TreatmentPlanStatus;
        currency: string;
        deletedAt: Date | null;
      }[]
    >`
      SELECT "status", "currency", "deletedAt" FROM "treatment_plans"
       WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${planId}::uuid
         FOR SHARE`;
    // Retirado o inexistente: sus solicitudes se borran y no se reparte. Un
    // plan no cobrable no tiene ítems facturables (ni nada que llenar).
    if (!plan || plan.deletedAt || !isPlanBillable(plan.status)) return 0;

    const bases = await tx.$queryRaw<{ paymentId: string }[]>`
      SELECT "paymentId" FROM "payment_plan_amounts"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "treatmentPlanId" = ${planId}::uuid
         AND "manual" = false
       ORDER BY "paymentId"
         FOR UPDATE`;
    if (bases.length === 0) return 0;

    const lockedItems = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "treatment_plan_items"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "planId" = ${planId}::uuid
         AND "deletedAt" IS NULL
         AND "status" IN ('ACCEPTED', 'DONE')
       ORDER BY "id"
         FOR UPDATE`;
    if (lockedItems.length === 0) return 0;

    const donors = await this.readDonors(
      tx,
      tenantId,
      plan.currency,
      bases.map((b) => b.paymentId),
    );
    const items = await this.readItems(
      tx,
      tenantId,
      lockedItems.map((i) => i.id),
    );
    const increments = decide({ donors, items });
    if (increments.length === 0) return 0;
    await this.writeIncrements(tx, tenantId, planId, actorId, increments);
    return increments.reduce((sum, inc) => sum + inc.cents, 0);
  }

  /**
   * Donantes entre las bases bloqueadas: abono vivo (leído DESPUÉS del bloqueo
   * de su base: una anulación que se le adelantó ya está confirmada aquí), base
   * aún no fijada y en la moneda del plan.
   */
  private async readDonors(
    tx: Prisma.TransactionClient,
    tenantId: string,
    planCurrency: string,
    paymentIds: string[],
  ): Promise<Donor[]> {
    const rows = await tx.$queryRaw<
      {
        paymentId: string;
        amount: Prisma.Decimal;
        paidAt: Date;
        createdAt: Date;
        allocated: Prisma.Decimal;
      }[]
    >`
      SELECT b."paymentId", b."amount", p."paidAt", p."createdAt",
             COALESCE((SELECT sum(a."amount") FROM "payment_allocations" a
                        WHERE a."tenantId" = b."tenantId"
                          AND a."paymentId" = b."paymentId"), 0) AS "allocated"
        FROM "payment_plan_amounts" b
        JOIN "payments" p
          ON p."tenantId" = b."tenantId" AND p."id" = b."paymentId"
       WHERE b."tenantId" = ${tenantId}::uuid
         AND b."paymentId" = ANY(${paymentIds}::uuid[])
         AND b."manual" = false
         AND b."currency" = ${planCurrency}
         AND p."deletedAt" IS NULL`;
    return rows.map((r) => ({
      paymentId: r.paymentId,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
      baseCents: toCents(r.amount),
      allocatedCents: toCents(r.allocated),
    }));
  }

  /** Ítems bloqueados con su facturable (plan ya comprobado cobrable) y lo imputado. */
  private async readItems(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemIds: string[],
  ): Promise<AllocatableItem[]> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        status: TreatmentPlanItemStatus;
        price: Prisma.Decimal;
        discount: Prisma.Decimal;
        deletedAt: Date | null;
        createdAt: Date;
        completedAt: Date | null;
        allocated: Prisma.Decimal;
      }[]
    >`
      SELECT i."id", i."status", i."price", i."discount", i."deletedAt",
             i."createdAt", i."completedAt",
             COALESCE((SELECT sum(a."amount") FROM "payment_allocations" a
                        WHERE a."tenantId" = i."tenantId"
                          AND a."treatmentPlanItemId" = i."id"), 0) AS "allocated"
        FROM "treatment_plan_items" i
       WHERE i."tenantId" = ${tenantId}::uuid
         AND i."id" = ANY(${itemIds}::uuid[])`;
    const items: AllocatableItem[] = [];
    for (const r of rows) {
      const billableCents = itemBillableCents(
        {
          status: r.status,
          price: Number(r.price),
          discount: Number(r.discount),
          deletedAt: r.deletedAt,
        },
        true,
      );
      if (billableCents === 0) continue;
      items.push({
        id: r.id,
        status: r.status === TreatmentPlanItemStatus.DONE ? 'DONE' : 'ACCEPTED',
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        billableCents,
        allocatedCents: toCents(r.allocated),
      });
    }
    return items;
  }

  /** Suma a la fila del par (abono, ítem) o la crea, AUTO; el guard es la red de R7. */
  private async writeIncrements(
    tx: Prisma.TransactionClient,
    tenantId: string,
    planId: string,
    actorId: string | null,
    increments: AllocationIncrement[],
  ): Promise<void> {
    const existing = await tx.paymentAllocation.findMany({
      where: {
        tenantId,
        treatmentPlanId: planId,
        paymentId: { in: [...new Set(increments.map((i) => i.paymentId))] },
      },
      select: { id: true, paymentId: true, treatmentPlanItemId: true },
    });
    const rowOf = new Map(
      existing.map((r) => [`${r.paymentId}:${r.treatmentPlanItemId}`, r.id]),
    );
    for (const inc of increments) {
      const rowId = rowOf.get(`${inc.paymentId}:${inc.itemId}`);
      if (rowId) {
        await tx.paymentAllocation.update({
          where: { id: rowId },
          data: { amount: { increment: fromCents(inc.cents) } },
          select: { id: true },
        });
      } else {
        await tx.paymentAllocation.create({
          data: {
            tenantId,
            paymentId: inc.paymentId,
            treatmentPlanId: planId,
            treatmentPlanItemId: inc.itemId,
            amount: fromCents(inc.cents),
            source: PaymentAllocationSource.AUTO,
            createdById: actorId,
          },
          select: { id: true },
        });
      }
    }
  }

  async pendingPlanIds(
    preferPlanId?: string,
    limit?: number,
  ): Promise<string[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<{ treatmentPlanId: string }[]>`
        SELECT "treatmentPlanId" FROM "plan_allocation_rebalance_requests"
         WHERE "tenantId" = ${tenantId}::uuid
         GROUP BY "treatmentPlanId"
         ORDER BY ("treatmentPlanId" = ${preferPlanId ?? null}::uuid) IS TRUE DESC,
                  min("id")
         LIMIT ${limit ?? null}::int`,
    );
    return rows.map((r) => r.treatmentPlanId);
  }

  async planOfPayment(paymentId: string): Promise<string | null> {
    const tenantId = this.requireTenantId();
    const payment = await this.prisma.runWithTenant((tx) =>
      tx.payment.findFirst({
        where: { tenantId, id: paymentId },
        select: { treatmentPlanId: true },
      }),
    );
    return payment?.treatmentPlanId ?? null;
  }

  async paymentsWithoutBase(limit: number): Promise<PaymentWithoutBase[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          amount: Prisma.Decimal;
          currency: string;
          paidAt: Date;
          locationId: string;
          planCurrency: string;
        }[]
      >`
        SELECT p."id", p."amount", p."currency", p."paidAt", p."locationId",
               t."currency" AS "planCurrency"
          FROM "payments" p
          JOIN "treatment_plans" t
            ON t."tenantId" = p."tenantId" AND t."id" = p."treatmentPlanId"
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."deletedAt" IS NULL
           AND t."deletedAt" IS NULL
           AND NOT EXISTS (
                 SELECT 1 FROM "payment_plan_amounts" b
                  WHERE b."tenantId" = p."tenantId" AND b."paymentId" = p."id")
         ORDER BY p."createdAt" DESC, p."id" DESC
         LIMIT ${limit}::int`;
      if (rows.length === 0) return [];
      // DX-097: la fecha de la tasa es el día civil del abono en SU sede.
      const zoneOf = await resolveLocationTimeZones(
        tx,
        tenantId,
        rows.map((r) => r.locationId),
      );
      return rows.map((r) => ({
        paymentId: r.id,
        amount: Number(r.amount),
        currency: r.currency,
        planCurrency: r.planCurrency,
        paidOn: civilDateIn(r.paidAt, zoneOf(r.locationId)),
      }));
    });
  }

  async ensureBase(
    paymentId: string,
    amount: number,
    currency: string,
    rateDate: string,
  ): Promise<boolean> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // FOR SHARE del abono vivo: una anulación en curso (que lo actualiza)
      // termina antes y aquí ya se ve anulado; si esta base gana, la anulación
      // la encuentra al bloquear la base tras anular (R12).
      const [payment] = await tx.$queryRaw<{ treatmentPlanId: string }[]>`
        SELECT "treatmentPlanId" FROM "payments"
         WHERE "tenantId" = ${tenantId}::uuid
           AND "id" = ${paymentId}::uuid
           AND "deletedAt" IS NULL
           AND "treatmentPlanId" IS NOT NULL
           FOR SHARE`;
      if (!payment) return false;
      // Convertida a la moneda que el plan tenía al leerlo; si cambió, otra
      // pasada la convertirá de nuevo.
      const created = await tx.$executeRaw`
        INSERT INTO "payment_plan_amounts"
               ("paymentId", "tenantId", "treatmentPlanId", "amount", "currency", "rateDate")
        SELECT ${paymentId}::uuid, ${tenantId}::uuid, t."id",
               ${amount.toFixed(2)}::numeric, ${currency}, ${rateDate}::date
          FROM "treatment_plans" t
         WHERE t."tenantId" = ${tenantId}::uuid
           AND t."id" = ${payment.treatmentPlanId}::uuid
           AND t."currency" = ${currency}
        ON CONFLICT DO NOTHING`;
      if (created === 0) return false;
      await enqueuePlanRebalance(tx, tenantId, payment.treatmentPlanId);
      return true;
    });
  }

  enqueuePlan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    planId: string,
  ): Promise<void> {
    return enqueuePlanRebalance(tx, tenantId, planId);
  }

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
