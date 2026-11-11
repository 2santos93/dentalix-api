import type { Prisma } from '@prisma/client';

/** Un recall que movió un procedimiento (lo devuelve el PATCH del ítem). */
export interface ProcedureRecallUpdate {
  recallId: string;
  recallTypeId: string;
  recallTypeName: string;
  /** Vencimiento guardado tras el recálculo (día civil). */
  dueAt: string;
}

export interface ProcedureRecallChange {
  tenantId: string;
  patientId: string;
  itemId: string;
  catalogItemId: string;
  /**
   * El ítem acaba de pasar a DONE: crea el recall de cada tipo disparado que
   * aún no lo tenga (D4). En una salida de DONE (CLEAR) o una corrección de
   * fecha o sede (CORRECT) solo se recalculan los que ya existen.
   */
  createMissing: boolean;
  /** Quien lo crea (`createdById`/`updatedById`); sin él no se crea nada. */
  actorId: string | null;
}

/**
 * DX-015-bis · «El reloj lo mueve el procedimiento». En la transacción del
 * cambio del ítem del plan (`PrismaTreatmentPlanRepository.updateItem`), por
 * cada tipo de recall ACTIVO que dispara su procedimiento:
 *
 * 1. Con `createMissing`, crea el recall si el paciente no tiene uno de ese
 *    tipo: intervalo por defecto del tipo, sede = la del DONE, base = el día
 *    civil del DONE en la zona de esa sede, `source = 'PROCEDURE'`. INSERT …
 *    ON CONFLICT sobre la UNIQUE (clínica, paciente, tipo): dos DONE
 *    concurrentes del mismo paciente dejan una sola fila. Un DONE que no se
 *    puede fechar (sin sede con zona) no crea nada.
 * 2. Recalcula la base desde la historia (`dx_recall_recompute`, que bloquea
 *    la fila antes de leer los ítems: queda el máximo).
 *
 * Devuelve los recalls que quedan, con su vencimiento nuevo. Bajo la RLS de la
 * transacción (`runWithTenant`).
 */
export async function recallsFromProcedure(
  tx: Prisma.TransactionClient,
  change: ProcedureRecallChange,
): Promise<ProcedureRecallUpdate[]> {
  const { tenantId, patientId, itemId, catalogItemId } = change;
  if (change.createMissing && change.actorId) {
    await tx.$executeRaw`
      INSERT INTO "patient_recalls"
        ("id", "tenantId", "patientId", "recallTypeId", "kind", "intervalMonths",
         "lastDoneAt", "lastDoneItemId", "locationId", "source",
         "createdById", "updatedById", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), rt."tenantId", ${patientId}::uuid, rt."id",
             rt."systemKey", rt."defaultIntervalMonths",
             ((i."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE l."timeZone")::date,
             i."id", i."performedLocationId", 'PROCEDURE',
             ${change.actorId}::uuid, ${change.actorId}::uuid,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM "recall_type_triggers" t
        JOIN "recall_types" rt
          ON rt."tenantId" = t."tenantId" AND rt."id" = t."recallTypeId"
         AND rt."active" AND rt."deletedAt" IS NULL
        JOIN "treatment_plan_items" i
          ON i."tenantId" = t."tenantId" AND i."id" = ${itemId}::uuid
        JOIN "locations" l
          ON l."tenantId" = i."tenantId" AND l."id" = i."performedLocationId"
       WHERE t."tenantId" = ${tenantId}::uuid
         AND t."catalogItemId" = ${catalogItemId}::uuid
         AND i."completedAt" IS NOT NULL
         AND l."timeZone" IS NOT NULL
      ON CONFLICT ("tenantId", "patientId", "recallTypeId") DO NOTHING`;
  }
  const types = await tx.$queryRaw<{ id: string }[]>`
    SELECT rt."id"
      FROM "recall_type_triggers" t
      JOIN "recall_types" rt
        ON rt."tenantId" = t."tenantId" AND rt."id" = t."recallTypeId"
       AND rt."active" AND rt."deletedAt" IS NULL
     WHERE t."tenantId" = ${tenantId}::uuid
       AND t."catalogItemId" = ${catalogItemId}::uuid
     ORDER BY rt."sortOrder", rt."id"`;
  if (types.length === 0) return [];
  for (const type of types) {
    await tx.$executeRaw`SELECT public.dx_recall_recompute(${tenantId}::uuid, ${patientId}::uuid, ${type.id}::uuid)`;
  }
  const rows = await tx.$queryRaw<
    {
      recallId: string;
      recallTypeId: string;
      recallTypeName: string;
      dueAt: Date;
    }[]
  >`
    SELECT pr."id" AS "recallId", pr."recallTypeId", rt."name" AS "recallTypeName",
           pr."dueAt"
      FROM "patient_recalls" pr
      JOIN "recall_types" rt
        ON rt."tenantId" = pr."tenantId" AND rt."id" = pr."recallTypeId"
     WHERE pr."tenantId" = ${tenantId}::uuid
       AND pr."patientId" = ${patientId}::uuid
       AND pr."recallTypeId" = ANY(${types.map((t) => t.id)}::uuid[])
     ORDER BY rt."sortOrder", rt."id"`;
  return rows.map((r) => ({
    recallId: r.recallId,
    recallTypeId: r.recallTypeId,
    recallTypeName: r.recallTypeName,
    dueAt: r.dueAt.toISOString().slice(0, 10),
  }));
}
