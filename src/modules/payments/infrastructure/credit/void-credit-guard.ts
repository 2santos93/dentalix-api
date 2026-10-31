import { ConflictException } from '@nestjs/common';
import type { Prisma, TreatmentPlanStatus } from '@prisma/client';
import {
  VOID_MOVED_CREDIT_MESSAGE,
  formatRefundNumber,
  toCents,
  voidRefundReferenceMessage,
  voidUncoversMovedCredit,
} from '../../../patient-credit/domain/patient-credit';
import { isPlanBillable } from '../../../treatment-plans/domain/plan-status-machine';

interface PlanSumsRow {
  id: string;
  status: TreatmentPlanStatus;
  currency: string;
  billable: string;
  paid: string;
  entries: string;
  outflow: string;
  voided: string;
}

/**
 * DX-253: antes de anular abonos (un abono suelto o TODAS las líneas de un
 * cobro dividido, DX-390), en la transacción de la anulación:
 *
 * 1. bloquea sus planes `FOR NO KEY UPDATE` en orden de id: el mismo bloqueo
 *    que toman el traspaso y la devolución, así que una anulación y un
 *    movimiento de saldo a favor (o dos anulaciones del mismo plan) se
 *    ordenan y cada uno ve lo que confirmó el otro;
 * 2. 409 si alguna línea es abono de referencia de una devolución (la
 *    devolución es inmutable: anular el abono la dejaría sin respaldo);
 * 3. 409 si de un plan ya salió saldo a favor (traspaso o devolución) y, sin
 *    las líneas anuladas, su saldo a favor neto quedaría negativo
 *    (`voidUncoversMovedCredit`).
 *
 * Las líneas ya anuladas por otra petición no cuentan (se releen tras el
 * bloqueo); las de un saldo migrado (sin plan) no tienen saldo a favor.
 */
export async function assertVoidKeepsPatientCredit(
  tx: Prisma.TransactionClient,
  tenantId: string,
  lineIds: string[],
): Promise<void> {
  if (lineIds.length === 0) return;
  const plans = await tx.$queryRaw<{ treatmentPlanId: string }[]>`
    SELECT DISTINCT "treatmentPlanId" FROM "payments"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "id" = ANY(${lineIds}::uuid[])
       AND "treatmentPlanId" IS NOT NULL`;
  if (plans.length === 0) return;
  const planIds = plans.map((p) => p.treatmentPlanId).sort();
  await tx.$queryRaw`
    SELECT "id" FROM "treatment_plans"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "id" = ANY(${planIds}::uuid[])
     ORDER BY "id"
     FOR NO KEY UPDATE`;

  const [reference] = await tx.$queryRaw<
    { seriesPrefix: string; number: number }[]
  >`
    SELECT r."seriesPrefix", r."number"
      FROM "patient_credit_refund_payments" rp
      JOIN "patient_credit_refunds" r
        ON r."tenantId" = rp."tenantId" AND r."id" = rp."refundId"
     WHERE rp."tenantId" = ${tenantId}::uuid
       AND rp."paymentId" = ANY(${lineIds}::uuid[])
     ORDER BY r."createdAt", r."id"
     LIMIT 1`;
  if (reference) {
    throw new ConflictException(
      voidRefundReferenceMessage(
        formatRefundNumber(reference.seriesPrefix, reference.number),
      ),
    );
  }

  const rows = await tx.$queryRaw<PlanSumsRow[]>`
    SELECT tp."id", tp."status", tp."currency",
           COALESCE((
             SELECT pg_catalog.sum(i."price") - pg_catalog.sum(i."discount")
               FROM "treatment_plan_items" i
              WHERE i."tenantId" = tp."tenantId" AND i."planId" = tp."id"
                AND i."deletedAt" IS NULL AND i."status" IN ('ACCEPTED', 'DONE')
           ), 0)::text AS "billable",
           COALESCE((
             SELECT pg_catalog.sum(p."amount") FROM "payments" p
              WHERE p."tenantId" = tp."tenantId" AND p."treatmentPlanId" = tp."id"
                AND p."currency" = tp."currency" AND p."deletedAt" IS NULL
           ), 0)::text AS "paid",
           COALESCE((
             SELECT pg_catalog.sum(e."amount") FROM "patient_credit_entries" e
              WHERE e."tenantId" = tp."tenantId" AND e."treatmentPlanId" = tp."id"
                AND e."currency" = tp."currency"
           ), 0)::text AS "entries",
           COALESCE((
             SELECT -pg_catalog.sum(e."amount") FROM "patient_credit_entries" e
              WHERE e."tenantId" = tp."tenantId" AND e."treatmentPlanId" = tp."id"
                AND e."currency" = tp."currency" AND e."amount" < 0
           ), 0)::text AS "outflow",
           COALESCE((
             SELECT pg_catalog.sum(p."amount") FROM "payments" p
              WHERE p."tenantId" = tp."tenantId" AND p."treatmentPlanId" = tp."id"
                AND p."currency" = tp."currency" AND p."deletedAt" IS NULL
                AND p."id" = ANY(${lineIds}::uuid[])
           ), 0)::text AS "voided"
      FROM "treatment_plans" tp
     WHERE tp."tenantId" = ${tenantId}::uuid
       AND tp."id" = ANY(${planIds}::uuid[])`;
  for (const row of rows) {
    const uncovered = voidUncoversMovedCredit({
      billableCents: isPlanBillable(row.status)
        ? toCents(Number(row.billable))
        : 0,
      paidCents: toCents(Number(row.paid)),
      entriesCents: toCents(Number(row.entries)),
      outflowCents: toCents(Number(row.outflow)),
      voidedCents: toCents(Number(row.voided)),
    });
    if (uncovered) throw new ConflictException(VOID_MOVED_CREDIT_MESSAGE);
  }
}
