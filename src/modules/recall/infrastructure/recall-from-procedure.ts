import type { Prisma } from '@prisma/client';
import type { ExclusionCandidate } from '../domain/recall-exclusion-rules';
import {
  deactivateExcluded,
  lockExclusionScope,
  type ExcludedRecall,
  type RecallReplacement,
} from './recall-exclusion';

/** Un recall que movió un procedimiento (lo devuelve el PATCH del ítem). */
export interface ProcedureRecallUpdate {
  recallId: string;
  recallTypeId: string;
  recallTypeName: string;
  /** Vencimiento guardado tras el recálculo (día civil). */
  dueAt: string;
  /**
   * DX-015-bis (D9): la exclusión lo acaba de desactivar porque otro recall
   * de un tipo del mismo grupo pasó a activo (`replacedBy`).
   */
  deactivated: boolean;
  /** El tipo del recall que lo sustituye; null si no se desactivó. */
  replacedBy: Omit<RecallReplacement, 'recallId'> | null;
}

/** Interno: un recall de los tipos disparados y si este cambio lo creó, movió o reactivó. */
export interface ProcedureRecallResult {
  recallId: string;
  recallTypeId: string;
  recallTypeName: string;
  dueAt: string;
  /** Solo entonces se audita (RECALL_FROM_PROCEDURE). */
  changed: boolean;
}

/** Lo que deja el cambio del ítem en los recalls del paciente. */
export interface ProcedureRecallOutcome {
  /** Los recalls de los tipos que dispara el procedimiento, en su orden. */
  recalls: ProcedureRecallResult[];
  /** Los que la exclusión desactivó (D9); alguno puede ser de `recalls`. */
  excluded: ExcludedRecall[];
}

export const NO_PROCEDURE_RECALLS: ProcedureRecallOutcome = {
  recalls: [],
  excluded: [],
};

export interface ProcedureRecallChange {
  tenantId: string;
  patientId: string;
  itemId: string;
  catalogItemId: string;
  /**
   * El ítem acaba de pasar a DONE: crea el recall de cada tipo disparado que
   * aún no lo tenga (D4), reactiva el que había desactivado la exclusión y
   * aplica la exclusión (D9). En una salida de DONE (CLEAR), una corrección
   * de fecha o sede (CORRECT) o el borrado de un ítem DONE solo se recalculan
   * los que ya existen: no son un procedimiento nuevo.
   */
  createMissing: boolean;
  /** Quien lo crea (`createdById`/`updatedById`); sin él no se crea nada. */
  actorId: string | null;
}

/**
 * `recallUpdates` del PATCH del ítem: los recalls del procedimiento, en su
 * orden, y después los que la exclusión desactivó (`deactivated: true`, con el
 * tipo que los sustituye). Uno de los del procedimiento que quede desactivado
 * (dos tipos del mismo grupo disparados a la vez) sale una sola vez.
 */
export function procedureRecallUpdates(
  outcome: ProcedureRecallOutcome,
): ProcedureRecallUpdate[] {
  const excluded = new Map(outcome.excluded.map((e) => [e.recallId, e]));
  const replaced = (e: ExcludedRecall | undefined) =>
    e
      ? {
          recallTypeId: e.replacedBy.recallTypeId,
          recallTypeName: e.replacedBy.recallTypeName,
        }
      : null;
  const own = outcome.recalls.map((r) => {
    const e = excluded.get(r.recallId);
    return {
      recallId: r.recallId,
      recallTypeId: r.recallTypeId,
      recallTypeName: r.recallTypeName,
      dueAt: r.dueAt,
      deactivated: e !== undefined,
      replacedBy: replaced(e),
    };
  });
  const ownIds = new Set(outcome.recalls.map((r) => r.recallId));
  const others = outcome.excluded
    .filter((e) => !ownIds.has(e.recallId))
    .map((e) => ({
      recallId: e.recallId,
      recallTypeId: e.recallTypeId,
      recallTypeName: e.recallTypeName,
      dueAt: e.dueAt,
      deactivated: true,
      replacedBy: replaced(e),
    }));
  return [...own, ...others];
}

/**
 * DX-015-bis · «El reloj lo mueve el procedimiento». En la transacción del
 * cambio del ítem del plan (`PrismaTreatmentPlanRepository.updateItem`), por
 * cada tipo de recall ACTIVO que dispara su procedimiento:
 *
 * 1. Con `createMissing` y algún tipo con grupo de exclusión, bloquea antes de
 *    escribir (`lockExclusionScope`: advisory lock del paciente y sus recalls
 *    de esos grupos en orden de id).
 * 2. Con `createMissing`, crea el recall si el paciente no tiene uno de ese
 *    tipo: intervalo por defecto del tipo, sede = la del DONE, base = el día
 *    civil del DONE en la zona de esa sede, `source = 'PROCEDURE'`. INSERT …
 *    ON CONFLICT sobre la UNIQUE (clínica, paciente, tipo): dos DONE
 *    concurrentes del mismo paciente dejan una sola fila. Un DONE que no se
 *    puede fechar (sin sede con zona) no crea nada.
 * 3. Recalcula la base desde la historia (`dx_recall_recompute`, que bloquea
 *    la fila antes de leer los ítems: queda el máximo).
 * 4. Con `createMissing` (D9, «el último procedimiento manda»): reactiva el
 *    recall del tipo que había desactivado la exclusión ("excludedAt"; uno
 *    retirado a mano sigue retirado) y, si uno de un tipo con grupo queda
 *    activo y este DONE lo creó, movió o reactivó, desactiva los demás
 *    recalls activos del paciente de ese grupo (`deactivateExcluded`).
 *
 * Devuelve los recalls de los tipos disparados, con su vencimiento y si este
 * cambio los creó, movió o reactivó, y los que desactivó la exclusión. Tipos
 * en orden estable (`sortOrder`, id) también en el INSERT: dos DONE
 * concurrentes que disparen varios tipos no se cruzan en la UNIQUE. Bajo la
 * RLS de la transacción (`runWithTenant`).
 */
export async function recallsFromProcedure(
  tx: Prisma.TransactionClient,
  change: ProcedureRecallChange,
): Promise<ProcedureRecallOutcome> {
  const { tenantId, patientId, itemId, catalogItemId } = change;
  if (change.createMissing && change.actorId) {
    await tx.$queryRaw`SELECT public.dx_recall_ensure_default_types(${tenantId}::uuid)`;
  }
  const types = await tx.$queryRaw<
    { id: string; exclusionGroup: string | null }[]
  >`
    SELECT rt."id", rt."exclusionGroup"
      FROM "recall_type_triggers" t
      JOIN "recall_types" rt
        ON rt."tenantId" = t."tenantId" AND rt."id" = t."recallTypeId"
       AND rt."active" AND rt."deletedAt" IS NULL
     WHERE t."tenantId" = ${tenantId}::uuid
       AND t."catalogItemId" = ${catalogItemId}::uuid
     ORDER BY rt."sortOrder", rt."id"`;
  if (types.length === 0) return NO_PROCEDURE_RECALLS;
  const typeIds = types.map((t) => t.id);
  const groups = types.flatMap((t) =>
    t.exclusionGroup ? [t.exclusionGroup] : [],
  );
  if (change.createMissing) {
    await lockExclusionScope(tx, tenantId, patientId, groups);
  }

  const moved = new Set<string>();
  if (change.createMissing && change.actorId) {
    const rows = await tx.$queryRaw<{ recallTypeId: string }[]>`
      INSERT INTO "patient_recalls"
        ("id", "tenantId", "patientId", "recallTypeId", "kind", "intervalMonths",
         "lastDoneAt", "lastDoneItemId", "locationId", "source",
         "createdById", "updatedById", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), rt."tenantId", ${patientId}::uuid, rt."id",
             rt."systemKey", rt."defaultIntervalMonths",
             ((i."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE l."timeZone")::date,
             i."id", i."performedLocationId", 'PROCEDURE',
             ${change.actorId}::uuid, ${change.actorId}::uuid,
             pg_catalog.timezone('UTC', pg_catalog.now()), pg_catalog.timezone('UTC', pg_catalog.now())
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
       ORDER BY rt."sortOrder", rt."id"
      ON CONFLICT ("tenantId", "patientId", "recallTypeId") DO NOTHING
      RETURNING "recallTypeId"`;
    for (const row of rows) moved.add(row.recallTypeId);
  }
  for (const type of types) {
    const [{ changed }] = await tx.$queryRaw<{ changed: boolean }[]>`
      SELECT public.dx_recall_recompute(${tenantId}::uuid, ${patientId}::uuid, ${type.id}::uuid) AS changed`;
    if (changed) moved.add(type.id);
  }
  if (change.createMissing) {
    // D9: el DONE devuelve el turno al recall que la exclusión había
    // desactivado. Uno retirado a mano (sin "excludedAt") sigue retirado.
    const reactivated = await tx.$queryRaw<{ recallTypeId: string }[]>`
      UPDATE "patient_recalls" pr
         SET "active" = true,
             "excludedAt" = NULL,
             "updatedById" = coalesce(${change.actorId}::uuid, pr."updatedById"),
             "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
       WHERE pr."tenantId" = ${tenantId}::uuid
         AND pr."patientId" = ${patientId}::uuid
         AND pr."recallTypeId" = ANY(${typeIds}::uuid[])
         AND NOT pr."active"
         AND pr."excludedAt" IS NOT NULL
      RETURNING pr."recallTypeId"`;
    for (const row of reactivated) moved.add(row.recallTypeId);
  }

  const rows = await tx.$queryRaw<
    {
      recallId: string;
      recallTypeId: string;
      recallTypeName: string;
      exclusionGroup: string | null;
      active: boolean;
      lastDoneAt: Date;
      intervalMonths: number;
      dueAt: Date;
    }[]
  >`
    SELECT pr."id" AS "recallId", pr."recallTypeId", rt."name" AS "recallTypeName",
           rt."exclusionGroup", pr."active", pr."lastDoneAt", pr."intervalMonths",
           pr."dueAt"
      FROM "patient_recalls" pr
      JOIN "recall_types" rt
        ON rt."tenantId" = pr."tenantId" AND rt."id" = pr."recallTypeId"
     WHERE pr."tenantId" = ${tenantId}::uuid
       AND pr."patientId" = ${patientId}::uuid
       AND pr."recallTypeId" = ANY(${typeIds}::uuid[])
     ORDER BY rt."sortOrder", rt."id"`;

  const excluded = change.createMissing
    ? await deactivateExcluded(tx, {
        tenantId,
        patientId,
        candidates: rows
          .filter((r) => r.active && moved.has(r.recallTypeId))
          .map((r): ExclusionCandidate => ({
            recallId: r.recallId,
            recallTypeId: r.recallTypeId,
            recallTypeName: r.recallTypeName,
            exclusionGroup: r.exclusionGroup,
            lastDoneAt: r.lastDoneAt.toISOString().slice(0, 10),
            intervalMonths: r.intervalMonths,
          })),
        actorId: change.actorId,
      })
    : [];
  return {
    recalls: rows.map((r) => ({
      recallId: r.recallId,
      recallTypeId: r.recallTypeId,
      recallTypeName: r.recallTypeName,
      dueAt: r.dueAt.toISOString().slice(0, 10),
      changed: moved.has(r.recallTypeId),
    })),
    excluded,
  };
}
