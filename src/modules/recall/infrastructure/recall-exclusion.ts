import type { Prisma } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  pickExclusionWinners,
  type ExclusionCandidate,
} from '../domain/recall-exclusion-rules';

/** El recall que sustituye a uno desactivado por la exclusión. */
export interface RecallReplacement {
  recallId: string;
  recallTypeId: string;
  recallTypeName: string;
}

/** Un recall que la exclusión acaba de desactivar (D9). */
export interface ExcludedRecall {
  recallId: string;
  recallTypeId: string;
  recallTypeName: string;
  /** Vencimiento guardado (día civil); no cambia al desactivarlo. */
  dueAt: string;
  replacedBy: RecallReplacement;
}

/** Clave del bloqueo de la exclusión de un paciente (transacción). */
export function exclusionLockKey(tenantId: string, patientId: string): string {
  return `dx015bis-recall-exclusion:${tenantId}:${patientId}`;
}

/**
 * DX-015-bis · Antes de escribir un recall de un tipo con grupo de exclusión
 * (DONE de un disparador o PUT), en la transacción del cambio:
 *
 * 1. Un advisory lock por paciente: dos DONE (o un DONE y un PUT) del mismo
 *    paciente que activan tipos del mismo grupo se serializan aquí. Sin él,
 *    dos altas concurrentes (higiene y perio, cada una en su plan) no se ven
 *    entre sí (filas sin confirmar) y quedarían las dos activas. El que espera
 *    lee, después, lo que confirmó el otro (READ COMMITTED: cada sentencia
 *    tiene su instantánea) y lo desactiva: «el último manda».
 * 2. TODOS los recalls del paciente, FOR UPDATE en orden de id, antes de
 *    cualquier escritura: el mismo orden y el mismo conjunto que bloquea
 *    `dx_recall_visit_location_refresh` (el alta de un recall y las citas lo
 *    llaman), así que el recálculo, la desactivación y esos triggers no se
 *    esperan en cruz. Son pocas filas (una por tipo).
 *
 * Sin grupos, nada (los tipos sin exclusión no pagan el bloqueo).
 */
export async function lockExclusionScope(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
  groups: readonly string[],
): Promise<void> {
  if (groups.length === 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${exclusionLockKey(tenantId, patientId)}, 0))`;
  await tx.$queryRaw`
    SELECT pr."id"
      FROM "patient_recalls" pr
     WHERE pr."tenantId" = ${tenantId}::uuid
       AND pr."patientId" = ${patientId}::uuid
     ORDER BY pr."id"
       FOR UPDATE`;
}

/**
 * D9 · «El último procedimiento manda». `candidates`: los recalls que este
 * cambio dejó activos y creó, movió o reactivó. Por cada grupo de exclusión se
 * queda uno (`pickExclusionWinners`) y se desactivan, en la misma transacción,
 * los demás recalls ACTIVOS del paciente cuyo tipo (vivo) comparta grupo, con
 * "excludedAt" (un DONE posterior de su disparador los reactiva). Las filas ya
 * están bloqueadas (`lockExclusionScope`). Devuelve los desactivados, con el
 * recall que los sustituye.
 */
export async function deactivateExcluded(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    patientId: string;
    candidates: readonly ExclusionCandidate[];
    /** Quien lo provoca (`updatedById`); sin él se conserva el anterior. */
    actorId: string | null;
  },
): Promise<ExcludedRecall[]> {
  const winners = pickExclusionWinners(params.candidates);
  if (winners.size === 0) return [];
  const groups = [...winners.keys()];
  const keep = [...winners.values()].map((w) => w.recallId);
  const rows = await tx.$queryRaw<
    {
      recallId: string;
      recallTypeId: string;
      recallTypeName: string;
      exclusionGroup: string;
      dueAt: Date;
    }[]
  >`
    UPDATE "patient_recalls" pr
       SET "active" = false,
           "excludedAt" = pg_catalog.timezone('UTC', pg_catalog.now()),
           "updatedById" = coalesce(${params.actorId}::uuid, pr."updatedById"),
           "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
      FROM "recall_types" rt
     WHERE pr."tenantId" = ${params.tenantId}::uuid
       AND pr."patientId" = ${params.patientId}::uuid
       AND pr."active"
       AND pr."id" <> ALL(${keep}::uuid[])
       AND rt."tenantId" = pr."tenantId"
       AND rt."id" = pr."recallTypeId"
       AND rt."deletedAt" IS NULL
       AND rt."exclusionGroup" = ANY(${groups}::text[])
    RETURNING pr."id" AS "recallId", pr."recallTypeId", rt."name" AS "recallTypeName",
              rt."exclusionGroup", pr."dueAt"`;
  return rows
    .flatMap((row) => {
      // Siempre lo hay: el UPDATE solo toca grupos de `winners`.
      const winner = winners.get(row.exclusionGroup);
      if (!winner) return [];
      return [
        {
          recallId: row.recallId,
          recallTypeId: row.recallTypeId,
          recallTypeName: row.recallTypeName,
          dueAt: row.dueAt.toISOString().slice(0, 10),
          replacedBy: {
            recallId: winner.recallId,
            recallTypeId: winner.recallTypeId,
            recallTypeName: winner.recallTypeName,
          },
        },
      ];
    })
    .sort((a, b) => a.recallId.localeCompare(b.recallId));
}

/**
 * D14 · Un `audit_event` PATIENT_RECALL (UPDATE, `reason: 'EXCLUSION'`) por
 * cada recall que la exclusión desactivó, en la transacción del cambio, con
 * el tipo y el recall que lo sustituye. Sin contexto de la petición (seed),
 * sin evento.
 */
export async function auditExclusions(
  tx: Prisma.TransactionClient,
  excluded: readonly ExcludedRecall[],
  patientId: string,
  audit: AuditRequestContext | undefined,
): Promise<void> {
  if (!audit) return;
  for (const recall of excluded) {
    await writeAuditEvent(tx, {
      tenantId: audit.tenantId,
      locationId: audit.locationId,
      actor: {
        kind: 'user',
        userId: audit.actor.userId,
        role: audit.actor.role,
      },
      action: 'UPDATE',
      resourceType: 'PATIENT_RECALL',
      resourceId: recall.recallId,
      patient: { kind: 'patient', id: patientId },
      requestId: audit.requestId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      metadata: {
        reason: 'EXCLUSION',
        params: {
          recallTypeId: recall.recallTypeId,
          replacedByRecallId: recall.replacedBy.recallId,
          replacedByRecallTypeId: recall.replacedBy.recallTypeId,
        },
      },
    });
  }
}
