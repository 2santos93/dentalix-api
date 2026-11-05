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
