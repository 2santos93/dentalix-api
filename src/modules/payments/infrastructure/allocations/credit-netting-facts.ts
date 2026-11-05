import { Prisma } from '@prisma/client';
import { toCents } from '../../../../shared/money/money';
import { NON_BILLABLE_PLAN_STATUSES } from '../../../treatment-plans/domain/plan-status-machine';
import {
  netUnallocated,
  type CreditOutEntry,
  type NettedPayment,
  type NettingPayment,
} from '../../domain/credit-netting';

/** Un abono vivo a un plan que se cobra con base y algo sin imputar, con lo que el informe pinta. */
export interface NettingFact extends NettingPayment {
  patientId: string;
  patientName: string;
  locationId: string;
  locationName: string;
  timeZone: string;
  paymentAmount: number;
  paymentCurrency: string;
  planCurrency: string;
  planCents: number;
  allocatedCents: number;
}

interface FactRow {
  id: string;
  planId: string;
  paidAt: Date;
  createdAt: Date;
  patientId: string;
  patientName: string;
  locationId: string;
  locationName: string;
  timeZone: string;
  paymentAmount: Prisma.Decimal;
  paymentCurrency: string;
  planCurrency: string;
  planAmount: Prisma.Decimal;
  allocated: Prisma.Decimal;
}

const cents = (value: Prisma.Decimal): number => toCents(value.toNumber());

/**
 * Los abonos candidatos (vivos, de un plan que se cobra —no cancelado ni
 * rechazado—, de un paciente vivo, con base y algo sin imputar) de los planes
 * que cumplan `planScope` (condición sobre `tp`), y sus salidas de saldo a
 * favor (devoluciones y traspasos de salida, asientos con signo en la moneda
 * del plan). Una consulta por tabla; la cascada la hace `netUnallocated`.
 * Lo comparten el informe «Cobrado sin imputar» y `GET /payments/:id/allocations`.
 */
export async function loadNettingFacts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  planScope: Prisma.Sql,
): Promise<{ facts: NettingFact[]; entries: CreditOutEntry[] }> {
  const rows = await tx.$queryRaw<FactRow[]>`
    SELECT p."id", tp."id" AS "planId", p."paidAt", p."createdAt", pt."id" AS "patientId",
           btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
           l."id" AS "locationId", l."name" AS "locationName", l."timeZone",
           p."amount" AS "paymentAmount", p."currency" AS "paymentCurrency",
           b."currency" AS "planCurrency", b."amount" AS "planAmount",
           al."allocated"
      FROM "payments" p
      JOIN "treatment_plans" tp
        ON tp."tenantId" = p."tenantId" AND tp."id" = p."treatmentPlanId"
      JOIN "patients" pt
        ON pt."tenantId" = p."tenantId" AND pt."id" = p."patientId"
      JOIN "locations" l
        ON l."tenantId" = p."tenantId" AND l."id" = p."locationId"
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
       AND ${planScope}`;
  const facts: NettingFact[] = rows.map((r) => {
    const planCents = cents(r.planAmount);
    const allocatedCents = cents(r.allocated);
    return {
      id: r.id,
      planId: r.planId,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
      patientId: r.patientId,
      patientName: r.patientName,
      locationId: r.locationId,
      locationName: r.locationName,
      timeZone: r.timeZone,
      paymentAmount: r.paymentAmount.toNumber(),
      paymentCurrency: r.paymentCurrency,
      planCurrency: r.planCurrency,
      planCents,
      allocatedCents,
      unallocatedCents: planCents - allocatedCents,
    };
  });
  const planIds = [...new Set(facts.map((f) => f.planId))];
  const entryRows =
    planIds.length === 0
      ? []
      : await tx.$queryRaw<
          { planId: string; createdAt: Date; amount: Prisma.Decimal }[]
        >`
          SELECT e."treatmentPlanId" AS "planId", e."createdAt", -e."amount" AS "amount"
            FROM "patient_credit_entries" e
           WHERE e."tenantId" = ${tenantId}::uuid
             AND e."kind" IN ('REFUND', 'TRANSFER_OUT')
             AND e."treatmentPlanId" = ANY(${planIds}::uuid[])`;
  return {
    facts,
    entries: entryRows.map((e) => ({
      planId: e.planId,
      createdAt: e.createdAt,
      cents: cents(e.amount),
    })),
  };
}

/** Los hechos ya netos: el resultado por abono junto a su hecho. */
export function nettedFacts(
  facts: readonly NettingFact[],
  entries: readonly CreditOutEntry[],
): { fact: NettingFact; net: NettedPayment }[] {
  const net = netUnallocated(facts, entries);
  return facts.map((fact) => ({
    fact,
    net: net.get(fact.id) as NettedPayment,
  }));
}

interface AffectedPlan {
  tenantId: string;
  planId: string;
  patientId: string;
  /** Σ devoluciones y traspasos de salida del plan (céntimos). */
  creditOutCents: number;
  /** Lo que la cascada atribuye a abonos del plan. */
  attributedCents: number;
  /** creditOutCents - attributedCents (> 0 = afectado). */
  discardedCents: number;
}

/**
 * Planes cuyas salidas del saldo a favor superan lo que la cascada atribuye a
 * sus abonos (DX-399-bis, diagnóstico de solo lectura).
 */
export async function findAffectedPlans(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AffectedPlan[]> {
  const outs = await tx.$queryRaw<
    { planId: string; patientId: string; cents: bigint }[]
  >`
    SELECT e."treatmentPlanId" AS "planId", e."patientId",
           round(-sum(e."amount") * 100)::bigint AS "cents"
      FROM "patient_credit_entries" e
      JOIN "treatment_plans" tp
        ON tp."tenantId" = e."tenantId" AND tp."id" = e."treatmentPlanId"
      JOIN "patients" pt
        ON pt."tenantId" = e."tenantId" AND pt."id" = e."patientId"
     WHERE e."tenantId" = ${tenantId}::uuid
       AND e."kind" IN ('REFUND', 'TRANSFER_OUT')
       -- Las MISMAS condiciones de \`loadNettingFacts\`: un plan cancelado,
       -- rechazado o borrado, o un paciente borrado, no tiene imputaciones que
       -- el fallo pudiera tocar (devolver desde un plan cancelado es normal).
       AND tp."deletedAt" IS NULL
       AND tp."status"::text NOT IN (${Prisma.join([...NON_BILLABLE_PLAN_STATUSES])})
       AND pt."deletedAt" IS NULL
     GROUP BY e."treatmentPlanId", e."patientId"`;
  if (outs.length === 0) return [];
  const planIds = outs.map((o) => o.planId);
  const { facts, entries } = await loadNettingFacts(
    tx,
    tenantId,
    Prisma.sql`tp."id" = ANY(${planIds}::uuid[])`,
  );
  const planOf = new Map(facts.map((f) => [f.id, f.planId]));
  const attributed = new Map<string, number>();
  for (const { fact, net } of nettedFacts(facts, entries)) {
    const planId = planOf.get(fact.id) as string;
    attributed.set(planId, (attributed.get(planId) ?? 0) + net.creditOutCents);
  }
  return outs
    .map((o) => {
      const creditOutCents = Number(o.cents);
      const attributedCents = attributed.get(o.planId) ?? 0;
      return {
        tenantId,
        planId: o.planId,
        patientId: o.patientId,
        creditOutCents,
        attributedCents,
        discardedCents: creditOutCents - attributedCents,
      };
    })
    .filter((p) => p.discardedCents > 0);
}
