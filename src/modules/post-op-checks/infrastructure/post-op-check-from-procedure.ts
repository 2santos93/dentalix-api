import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { loadLocationBusinessCalendar } from '../../../shared/locations/location-business-calendar';
import { civilDateIn, isValidTimeZone } from '../../../shared/time/civil-day';
import { postOpCheckDueOn } from '../domain/post-op-check-rules';

const logger = new Logger('PostOpCheckFromProcedure');

/** El ítem tal como queda tras el cambio (dentro de la transacción del ítem). */
export interface PostOpProcedureItem {
  id: string;
  patientId: string;
  catalogItemId: string;
  performedById: string | null;
  performedLocationId: string | null;
  completedAt: Date | null;
}

interface Scheduling {
  dueOn: string;
  timeZone: string;
  completedDay: string;
}

/**
 * Día de la llamada en la sede del procedimiento, o null (con un aviso en el
 * log) si la sede no tiene zona o calendario: como el recall, eso nunca
 * bloquea el DONE ni su corrección.
 */
async function scheduleFor(
  tx: Prisma.TransactionClient,
  tenantId: string,
  item: PostOpProcedureItem,
  afterDays: number,
): Promise<Scheduling | null> {
  const { performedLocationId: locationId, completedAt } = item;
  if (!locationId || !completedAt) return null;
  const location = await tx.location.findFirst({
    where: { id: locationId, tenantId },
    select: { timeZone: true, workingCalendar: { select: { tenantId: true } } },
  });
  if (
    !location?.timeZone ||
    !isValidTimeZone(location.timeZone) ||
    !location.workingCalendar
  ) {
    logger.warn(
      `DX-566: el ítem ${item.id} del tenant ${tenantId} pide control postoperatorio pero la sede ${locationId} no tiene zona horaria o calendario: no se crea el control`,
    );
    return null;
  }
  const calendar = await loadLocationBusinessCalendar(tx, tenantId, locationId);
  // Horario de la sede: un día sin tramos vivos está cerrado (como el
  // laboratorio). Sin horario (o retirado), sin restricción.
  const schedule = await tx.locationSchedule.findFirst({
    where: { locationId, deletedAt: null },
    select: {
      ranges: { where: { deletedAt: null }, select: { weekday: true } },
    },
  });
  const openWeekdays = schedule
    ? [...new Set(schedule.ranges.map((r) => r.weekday))].sort()
    : null;
  return {
    dueOn: postOpCheckDueOn(
      completedAt,
      afterDays,
      {
        workingWeekdays: calendar.workingWeekdays,
        holidays: calendar.holidays,
      },
      openWeekdays,
      calendar.timeZone,
    ),
    timeZone: calendar.timeZone,
    completedDay: civilDateIn(completedAt, calendar.timeZone),
  };
}

function auditDraft(
  audit: AuditRequestContext,
  checkId: string,
  patientId: string,
  action: 'CREATE' | 'UPDATE',
  reason: string,
  extra: Record<string, unknown> = {},
) {
  return {
    tenantId: audit.tenantId,
    locationId: audit.locationId,
    actor: {
      kind: 'user' as const,
      userId: audit.actor.userId,
      role: audit.actor.role,
    },
    action,
    resourceType: 'POST_OP_CHECK' as const,
    resourceId: checkId,
    patient: { kind: 'patient' as const, id: patientId },
    requestId: audit.requestId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    metadata: { reason, ...extra },
  };
}

/**
 * DX-566 · D3. En la transacción de `updateItem`, cuando el ítem acaba de
 * pasar a DONE: si su procedimiento pide control (`requiresPostOpCheck`), crea
 * el control PENDING para el `postOpCheckAfterDays`-ésimo día hábil de la sede
 * del procedimiento (día civil de `completedAt` en su zona). La cita: la del
 * cierre (`appointmentId`, DX-439) o, si no viene, la cita viva ligada al ítem
 * en la misma sede, COMPLETED o con el paciente en la clínica, del mismo día
 * civil; si no hay, sin cita. INSERT … ON CONFLICT sobre el único parcial
 * (un PENDING por ítem): dos DONE a la vez dejan uno. Sede sin zona o sin
 * calendario: no se crea nada (aviso en el log). Audita CREATE POST_OP_CHECK
 * con quien lo marcó hecho. Devuelve el id creado o null.
 */
export async function postOpCheckFromProcedure(
  tx: Prisma.TransactionClient,
  change: {
    tenantId: string;
    item: PostOpProcedureItem;
    appointmentId?: string | null;
    audit?: AuditRequestContext;
  },
): Promise<string | null> {
  const { tenantId, item } = change;
  if (!item.performedById || !item.performedLocationId || !item.completedAt) {
    return null;
  }
  const [catalog] = await tx.$queryRaw<
    { afterDays: number; procedureName: string }[]
  >`
    SELECT c."postOpCheckAfterDays"::int AS "afterDays", c."labelEs" AS "procedureName"
      FROM "dental_catalog_items" c
     WHERE c."tenantId" = ${tenantId}::uuid
       AND c."id" = ${item.catalogItemId}::uuid
       AND c."requiresPostOpCheck"`;
  if (!catalog) return null;
  const scheduling = await scheduleFor(tx, tenantId, item, catalog.afterDays);
  if (!scheduling) return null;

  let appointmentId = change.appointmentId ?? null;
  if (!appointmentId) {
    const [linked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT a."id"
        FROM "appointments" a
        JOIN "appointment_plan_items" ap
          ON ap."tenantId" = a."tenantId" AND ap."appointmentId" = a."id"
         AND ap."planItemId" = ${item.id}::uuid AND ap."deletedAt" IS NULL
       WHERE a."tenantId" = ${tenantId}::uuid
         AND a."patientId" = ${item.patientId}::uuid
         AND a."locationId" = ${item.performedLocationId}::uuid
         AND a."deletedAt" IS NULL
         AND a."status" IN ('COMPLETED', 'ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
         AND ((a."start" AT TIME ZONE 'UTC') AT TIME ZONE ${scheduling.timeZone})::date
             = ${scheduling.completedDay}::date
       ORDER BY a."start" DESC, a."id"
       LIMIT 1`;
    appointmentId = linked?.id ?? null;
  }

  const [created] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "post_op_checks"
      ("id", "tenantId", "patientId", "planItemId", "appointmentId", "locationId",
       "professionalId", "catalogItemId", "procedureName", "dueOn", "status",
       "createdAt", "updatedAt")
    VALUES
      (gen_random_uuid(), ${tenantId}::uuid, ${item.patientId}::uuid, ${item.id}::uuid,
       ${appointmentId}::uuid, ${item.performedLocationId}::uuid,
       ${item.performedById}::uuid, ${item.catalogItemId}::uuid,
       left(btrim(${catalog.procedureName}), 200), ${scheduling.dueOn}::date, 'PENDING',
       pg_catalog.timezone('UTC', pg_catalog.now()), pg_catalog.timezone('UTC', pg_catalog.now()))
    ON CONFLICT ("tenantId", "planItemId") WHERE "status" = 'PENDING' DO NOTHING
    RETURNING "id"`;
  if (!created) return null;
  if (change.audit) {
    await writeAuditEvent(
      tx,
      auditDraft(
        change.audit,
        created.id,
        item.patientId,
        'CREATE',
        'POST_OP_CHECK_CREATED',
        {
          params: {
            itemId: item.id,
            ...(appointmentId ? { appointmentId } : {}),
          },
        },
      ),
    );
  }
  return created.id;
}

/**
 * DX-566 · D4. El ítem sale de DONE (CLEAR) o se borra: su control PENDING
 * pasa a CANCELLED con el motivo, en la misma transacción. Uno ya cerrado no
 * cambia (su desenlace es clínico). Quien lo cierra: `actorId` (quien hizo el
 * cambio) o, sin sesión, quien había hecho el procedimiento.
 */
export async function cancelPendingPostOpCheck(
  tx: Prisma.TransactionClient,
  change: {
    tenantId: string;
    itemId: string;
    reason: 'PROCEDURE_REVERTED' | 'ITEM_DELETED';
    actorId: string | null;
    audit?: AuditRequestContext;
  },
): Promise<string | null> {
  const [cancelled] = await tx.$queryRaw<{ id: string; patientId: string }[]>`
    UPDATE "post_op_checks" c
       SET "status" = 'CANCELLED',
           "cancelledReason" = ${change.reason}::"PostOpCheckCancelReason",
           "closedAt" = pg_catalog.timezone('UTC', pg_catalog.now()),
           "closedById" = coalesce(${change.actorId}::uuid, c."professionalId"),
           "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
     WHERE c."tenantId" = ${change.tenantId}::uuid
       AND c."planItemId" = ${change.itemId}::uuid
       AND c."status" = 'PENDING'
    RETURNING c."id", c."patientId"`;
  if (!cancelled) return null;
  if (change.audit) {
    await writeAuditEvent(
      tx,
      auditDraft(
        change.audit,
        cancelled.id,
        cancelled.patientId,
        'UPDATE',
        change.reason === 'ITEM_DELETED'
          ? 'POST_OP_CHECK_ITEM_DELETED'
          : 'POST_OP_CHECK_PROCEDURE_REVERTED',
        {
          params: { itemId: change.itemId },
          statusChange: { from: 'PENDING', to: 'CANCELLED' },
        },
      ),
    );
  }
  return cancelled.id;
}

/**
 * DX-566 · D4. Un ADMIN corrige un ítem DONE (CORRECT) con el control aún
 * PENDING: se recalculan el día de la llamada y la sede (y el profesional)
 * con la nueva fecha o sede. Si la sede nueva no tiene zona o calendario, el
 * control se queda como estaba (aviso en el log). Auditado si cambia algo.
 */
export async function reschedulePendingPostOpCheck(
  tx: Prisma.TransactionClient,
  change: {
    tenantId: string;
    item: PostOpProcedureItem;
    audit?: AuditRequestContext;
  },
): Promise<string | null> {
  const { tenantId, item } = change;
  const [pending] = await tx.$queryRaw<
    {
      id: string;
      dueOn: Date;
      locationId: string;
      professionalId: string;
      afterDays: number;
    }[]
  >`
    SELECT c."id", c."dueOn", c."locationId", c."professionalId",
           k."postOpCheckAfterDays"::int AS "afterDays"
      FROM "post_op_checks" c
      JOIN "dental_catalog_items" k
        ON k."tenantId" = c."tenantId" AND k."id" = c."catalogItemId"
     WHERE c."tenantId" = ${tenantId}::uuid
       AND c."planItemId" = ${item.id}::uuid
       AND c."status" = 'PENDING'
       FOR UPDATE OF c`;
  if (!pending) return null;
  const scheduling = await scheduleFor(tx, tenantId, item, pending.afterDays);
  if (!scheduling) return null;
  const before = pending.dueOn.toISOString().slice(0, 10);
  const locationId = item.performedLocationId as string;
  const professionalId = item.performedById ?? pending.professionalId;
  if (
    before === scheduling.dueOn &&
    locationId === pending.locationId &&
    professionalId === pending.professionalId
  ) {
    return null;
  }
  await tx.$executeRaw`
    UPDATE "post_op_checks"
       SET "dueOn" = ${scheduling.dueOn}::date,
           "locationId" = ${locationId}::uuid,
           "professionalId" = ${professionalId}::uuid,
           "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
     WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${pending.id}::uuid`;
  if (change.audit) {
    await writeAuditEvent(
      tx,
      auditDraft(
        change.audit,
        pending.id,
        item.patientId,
        'UPDATE',
        'POST_OP_CHECK_RESCHEDULED',
        { params: { itemId: item.id } },
      ),
    );
  }
  return pending.id;
}
