import { UnprocessableEntityException } from '@nestjs/common';
import type { Prisma, RecallKind } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { AuditRecallVia } from '../../audit/domain/audit-metadata';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  auditExclusions,
  deactivateExcluded,
  lockExclusionScope,
  type ExcludedRecall,
} from './recall-exclusion';
import type { ProcedureRecallUpdate } from './recall-from-procedure';

/**
 * DX-015-bis (porción 3) · Escrituras de recall fuera del PUT de la ficha:
 * «Programar recall» con el intervalo por defecto del tipo (D15) y el
 * intervalo fijado al registrar la evolución (D18). Mismo orden de bloqueo
 * que el DONE y el PUT (`lockExclusionScope`), misma exclusión (D9) y la misma
 * auditoría (PATIENT_RECALL/UPDATE), con `via`.
 */

export const RECALL_TYPE_UNAVAILABLE_MESSAGE =
  'Ese tipo de recall no existe en esta clínica o se retiró.';
export const RECALL_TYPE_INACTIVE_MESSAGE =
  'Ese tipo de recall está desactivado: actívalo en Ajustes › Recall o elige otro.';

/** Un tipo vivo de la clínica con lo que necesitan estas escrituras. */
export interface LiveRecallType {
  id: string;
  name: string;
  systemKey: RecallKind | null;
  exclusionGroup: string | null;
  defaultIntervalMonths: number;
  active: boolean;
}

/** El tipo vivo (activo o no) de la clínica; null si no existe o se retiró. */
export async function findLiveRecallType(
  tx: Prisma.TransactionClient,
  tenantId: string,
  recallTypeId: string,
): Promise<LiveRecallType | null> {
  const [row] = await tx.$queryRaw<LiveRecallType[]>`
    SELECT rt."id", rt."name", rt."systemKey", rt."exclusionGroup",
           rt."defaultIntervalMonths", rt."active"
      FROM "recall_types" rt
     WHERE rt."tenantId" = ${tenantId}::uuid
       AND rt."id" = ${recallTypeId}::uuid
       AND rt."deletedAt" IS NULL`;
  return row ?? null;
}

/** 422 si el tipo no existe en la clínica o se retiró. */
export async function requireLiveRecallType(
  tx: Prisma.TransactionClient,
  tenantId: string,
  recallTypeId: string,
): Promise<LiveRecallType> {
  const type = await findLiveRecallType(tx, tenantId, recallTypeId);
  if (!type)
    throw new UnprocessableEntityException(RECALL_TYPE_UNAVAILABLE_MESSAGE);
  return type;
}

export interface NewManualRecall {
  tenantId: string;
  patientId: string;
  type: LiveRecallType;
  intervalMonths: number;
  /** Día civil fijado (`manualDoneAt`): la base. */
  baseDay: string;
  locationId: string;
  actorId: string;
}

/**
 * Alta de un recall MANUAL con la base fijada (`manualDoneAt` = `baseDay`) y
 * su recálculo (`dx_recall_recompute`: la base es el máximo con el último DONE
 * de un disparador). INSERT … ON CONFLICT sobre la UNIQUE (clínica, paciente,
 * tipo): si ya existe uno de ese tipo (también uno que otra petición acaba de
 * confirmar), no escribe nada y devuelve null. Las filas del paciente ya
 * están bloqueadas (`lockExclusionScope`).
 */
export async function insertManualRecall(
  tx: Prisma.TransactionClient,
  data: NewManualRecall,
): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "patient_recalls"
      ("id", "tenantId", "patientId", "recallTypeId", "kind", "intervalMonths",
       "lastDoneAt", "manualDoneAt", "locationId", "source",
       "createdById", "updatedById", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${data.tenantId}::uuid, ${data.patientId}::uuid,
            ${data.type.id}::uuid, ${data.type.systemKey}::"RecallKind",
            ${data.intervalMonths}::int, ${data.baseDay}::date, ${data.baseDay}::date,
            ${data.locationId}::uuid, 'MANUAL',
            ${data.actorId}::uuid, ${data.actorId}::uuid,
            pg_catalog.timezone('UTC', pg_catalog.now()),
            pg_catalog.timezone('UTC', pg_catalog.now()))
    ON CONFLICT ("tenantId", "patientId", "recallTypeId") DO NOTHING
    RETURNING "id"`;
  if (!row) return null;
  await tx.$executeRaw`SELECT public.dx_recall_recompute(${data.tenantId}::uuid, ${data.patientId}::uuid, ${data.type.id}::uuid)`;
  return row.id;
}

/**
 * D9: un alta o una reactivación de un recall de un tipo con grupo desactiva
 * los demás recalls activos del paciente de ese grupo, y se audita cada uno
 * (`reason: 'EXCLUSION'`). Sin grupo, nada.
 */
export async function excludeOthers(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    patientId: string;
    recallId: string;
    type: LiveRecallType;
    actorId: string;
    audit: AuditRequestContext | undefined;
  },
): Promise<ExcludedRecall[]> {
  if (!params.type.exclusionGroup) return [];
  const [now] = await tx.$queryRaw<
    { lastDoneAt: Date; intervalMonths: number }[]
  >`
    SELECT pr."lastDoneAt", pr."intervalMonths"
      FROM "patient_recalls" pr
     WHERE pr."tenantId" = ${params.tenantId}::uuid
       AND pr."id" = ${params.recallId}::uuid`;
  const excluded = await deactivateExcluded(tx, {
    tenantId: params.tenantId,
    patientId: params.patientId,
    candidates: [
      {
        recallId: params.recallId,
        recallTypeId: params.type.id,
        recallTypeName: params.type.name,
        exclusionGroup: params.type.exclusionGroup,
        lastDoneAt: now.lastDoneAt.toISOString().slice(0, 10),
        intervalMonths: now.intervalMonths,
      },
    ],
    actorId: params.actorId,
  });
  await auditExclusions(tx, excluded, params.patientId, params.audit);
  return excluded;
}

/**
 * El evento del recall creado o cambiado, como el del PUT (PATIENT_RECALL,
 * UPDATE, con el paciente), en la transacción del cambio y con `via`: el
 * tipo y, si la hay, la evolución en `params`; los nombres de los campos que
 * se fijaron en `changedFields` (nunca sus valores). Sin contexto de la
 * petición (seed), sin evento.
 */
export async function auditRecallWrite(
  tx: Prisma.TransactionClient,
  event: {
    recallId: string;
    recallTypeId: string;
    patientId: string;
    via: AuditRecallVia;
    changedFields: string[];
    entryId?: string;
  },
  audit: AuditRequestContext | undefined,
): Promise<void> {
  if (!audit) return;
  await writeAuditEvent(tx, {
    tenantId: audit.tenantId,
    locationId: audit.locationId,
    actor: { kind: 'user', userId: audit.actor.userId, role: audit.actor.role },
    action: 'UPDATE',
    resourceType: 'PATIENT_RECALL',
    resourceId: event.recallId,
    patient: { kind: 'patient', id: event.patientId },
    requestId: audit.requestId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    metadata: {
      via: event.via,
      changedFields: event.changedFields,
      params: {
        recallTypeId: event.recallTypeId,
        ...(event.entryId ? { entryId: event.entryId } : {}),
      },
    },
  });
}

/** D18: lo que la evolución pide del recall. */
export interface EntryRecallRequest {
  recallTypeId: string;
  intervalMonths: number;
}

export interface EntryRecallChange extends EntryRecallRequest {
  tenantId: string;
  patientId: string;
  entryId: string;
  /** Día civil de la evolución: la base de un recall nuevo. */
  entryDay: string;
  /** Sede de la evolución (la de su cita o la de escritura). */
  locationId: string;
  actorId: string;
  audit: AuditRequestContext | undefined;
}

/**
 * D18 · El intervalo del recall fijado al registrar la evolución, en SU
 * transacción (un 422 aquí deshace también la evolución):
 *
 * - Tipo inexistente o retirado → 422. Uno desactivado se acepta, como en el
 *   PUT (desactivar un tipo solo deja de crear recalls por procedimiento).
 * - Sin recall de ese tipo: se crea MANUAL con la base en el día de la
 *   evolución y la sede de la evolución.
 * - Con recall: solo cambia `intervalMonths`; la base no se toca. Si estaba
 *   inactivo (retirado a mano o excluido) se reactiva.
 * - Un alta o una reactivación aplica la exclusión (D9), como el PUT.
 *
 * Devuelve `recallUpdates` como el PATCH del ítem: el recall de la evolución
 * y después los que la exclusión desactivó.
 */
export async function recallFromClinicalEntry(
  tx: Prisma.TransactionClient,
  change: EntryRecallChange,
): Promise<ProcedureRecallUpdate[]> {
  const { tenantId, patientId } = change;
  const type = await requireLiveRecallType(tx, tenantId, change.recallTypeId);
  await lockExclusionScope(
    tx,
    tenantId,
    patientId,
    type.exclusionGroup ? [type.exclusionGroup] : [],
  );
  let recallId = await insertManualRecall(tx, {
    tenantId,
    patientId,
    type,
    intervalMonths: change.intervalMonths,
    baseDay: change.entryDay,
    locationId: change.locationId,
    actorId: change.actorId,
  });
  let activated = recallId !== null;
  let changedFields = ['intervalMonths', 'lastDoneAt'];
  if (recallId === null) {
    // Ya existe (bloqueado arriba o, si lo acaba de crear otra petición,
    // aquí): solo el intervalo y, si estaba inactivo, la reactivación.
    const [existing] = await tx.$queryRaw<{ id: string; active: boolean }[]>`
      SELECT pr."id", pr."active"
        FROM "patient_recalls" pr
       WHERE pr."tenantId" = ${tenantId}::uuid
         AND pr."patientId" = ${patientId}::uuid
         AND pr."recallTypeId" = ${type.id}::uuid
         FOR UPDATE`;
    recallId = existing.id;
    activated = !existing.active;
    changedFields = activated
      ? ['active', 'intervalMonths']
      : ['intervalMonths'];
    await tx.$executeRaw`
      UPDATE "patient_recalls" pr
         SET "intervalMonths" = ${change.intervalMonths}::int,
             "active" = true,
             "excludedAt" = NULL,
             "updatedById" = ${change.actorId}::uuid,
             "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
       WHERE pr."tenantId" = ${tenantId}::uuid
         AND pr."id" = ${recallId}::uuid`;
  }
  await auditRecallWrite(
    tx,
    {
      recallId,
      recallTypeId: type.id,
      patientId,
      via: 'CLINICAL_ENTRY',
      changedFields,
      entryId: change.entryId,
    },
    change.audit,
  );
  const excluded = activated
    ? await excludeOthers(tx, {
        tenantId,
        patientId,
        recallId,
        type,
        actorId: change.actorId,
        audit: change.audit,
      })
    : [];
  const [after] = await tx.$queryRaw<{ dueAt: Date }[]>`
    SELECT pr."dueAt" FROM "patient_recalls" pr
     WHERE pr."tenantId" = ${tenantId}::uuid AND pr."id" = ${recallId}::uuid`;
  return [
    {
      recallId,
      recallTypeId: type.id,
      recallTypeName: type.name,
      dueAt: after.dueAt.toISOString().slice(0, 10),
      deactivated: false,
      replacedBy: null,
    },
    ...excluded.map((e) => ({
      recallId: e.recallId,
      recallTypeId: e.recallTypeId,
      recallTypeName: e.recallTypeName,
      dueAt: e.dueAt,
      deactivated: true,
      replacedBy: {
        recallTypeId: e.replacedBy.recallTypeId,
        recallTypeName: e.replacedBy.recallTypeName,
      },
    })),
  ];
}
