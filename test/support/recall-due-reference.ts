import { Prisma } from '@prisma/client';
import type {
  RecallDueQuery,
  RecallDueRow,
} from '../../src/modules/recall/domain/recall.entity';

/**
 * DX-547 · ORÁCULO de la lista de recall: la consulta de DX-015 en su forma
 * más directa (cuenta y página en dos sentencias, cada una con la CTE completa
 * de todos los recall de la clínica, sin cotas ni índices). Solo la usan los
 * tests de equivalencia: la consulta de la app tiene que devolver exactamente
 * lo mismo. No la cambies para que un test pase: es la definición de la regla.
 *
 * DX-015-bis la reescribe con la regla nueva (`rule: 'DX-015-bis'`, la de
 * siempre): la base es "lastDoneAt" (lo fijado o el último DONE de un
 * disparador, que mantiene la BD) y el vencimiento se calcula AQUÍ
 * ("lastDoneAt" + intervalo), sin leer la columna generada: así también
 * comprueba esa columna. La última cita atendida solo da la sede del paciente.
 * `rule: 'DX-015'` conserva la regla anterior (la base es el MAX con la última
 * cita atendida, de cualquier tipo): es la definición de «lo que se veía
 * antes del despliegue» para el test del relleno.
 */

export type RecallDueRule = 'DX-015' | 'DX-015-bis';

interface ReferenceSqlRow {
  recallId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  phoneRegion: string | null;
  reminderOptedOut: boolean;
  kind: RecallDueRow['kind'];
  recallTypeId: string;
  recallTypeName: string;
  intervalMonths: number;
  baseDate: Date;
  dueAt: Date;
  daysOverdue: number;
  locationId: string;
  lastContactChannel:
    NonNullable<RecallDueRow['lastContact']>['channel'] | null;
  lastContactOutcome:
    NonNullable<RecallDueRow['lastContact']>['outcome'] | null;
  lastContactAt: Date | null;
}

const civilOf = (date: Date): string => date.toISOString().slice(0, 10);

function referenceFacts(now: Date, extra: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
      SELECT pr."id", pr."tenantId", pr."patientId", pr."kind", pr."recallTypeId",
             rt."name" AS "recallTypeName", pr."intervalMonths",
             pr."lastDoneAt", pr."active", pr."disabledUntil",
             pr."disabledReason", pr."updatedAt", pr."updatedById",
             pa."firstName", pa."lastName", pa."phone",
             (pa."reminderOptOutAt" IS NOT NULL) AS "reminderOptedOut",
             lo."id" AS "homeLocationId",
             lo."defaultPhoneRegion" AS "phoneRegion",
             ((${now}::timestamptz) AT TIME ZONE coalesce(lo."timeZone", 'UTC'))::date AS "today",
             ((lc."start" AT TIME ZONE 'UTC') AT TIME ZONE coalesce(lo."timeZone", 'UTC'))::date AS "lastCompletedVisit",
             EXISTS (
               SELECT 1 FROM "appointments" a
                WHERE a."tenantId" = pr."tenantId"
                  AND a."patientId" = pr."patientId"
                  AND a."deletedAt" IS NULL
                  AND (
                    (a."status" IN ('SCHEDULED', 'CONFIRMED') AND a."start" > ${now})
                    OR a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
                  )
             ) AS "hasUpcomingAppointment"
        FROM "patient_recalls" pr
        JOIN "patients" pa
          ON pa."tenantId" = pr."tenantId" AND pa."id" = pr."patientId"
        JOIN "recall_types" rt
          ON rt."tenantId" = pr."tenantId" AND rt."id" = pr."recallTypeId"
        LEFT JOIN LATERAL (
          SELECT a."start", a."locationId"
            FROM "appointments" a
           WHERE a."tenantId" = pr."tenantId"
             AND a."patientId" = pr."patientId"
             AND a."status" = 'COMPLETED'
             AND a."deletedAt" IS NULL
           ORDER BY a."start" DESC, a."id" DESC
           LIMIT 1
        ) lc ON true
        JOIN "locations" lo
          ON lo."tenantId" = pr."tenantId"
         AND lo."id" = coalesce(lc."locationId", pr."locationId")
       WHERE TRUE ${extra}`;
}

/** Cuenta y página según `rule`, dentro de `tx` (RLS del tenant). */
export async function referenceListDue(
  tx: Prisma.TransactionClient,
  query: RecallDueQuery,
  scopeIds: string[] | undefined,
  rule: RecallDueRule = 'DX-015-bis',
): Promise<{ rows: RecallDueRow[]; total: number }> {
  const locationFilter = scopeIds
    ? Prisma.sql`AND d."homeLocationId" = ANY(${scopeIds}::uuid[])`
    : Prisma.empty;
  const kindFilter = query.kind
    ? Prisma.sql`AND pr."kind" = ${query.kind}::"RecallKind"`
    : Prisma.empty;
  const typeFilter = query.recallTypeId
    ? Prisma.sql`AND pr."recallTypeId" = ${query.recallTypeId}::uuid`
    : Prisma.empty;
  const facts = referenceFacts(
    query.now,
    Prisma.sql`AND pr."active" AND pa."deletedAt" IS NULL ${kindFilter} ${typeFilter}`,
  );
  const base =
    rule === 'DX-015'
      ? Prisma.sql`greatest(f."lastDoneAt", f."lastCompletedVisit")`
      : Prisma.sql`f."lastDoneAt"`;
  const due = Prisma.sql`
      WITH f AS (${facts}),
      d AS (
        SELECT f.*,
               ${base} AS "baseDate",
               (${base} + make_interval(months => f."intervalMonths"))::date AS "dueAt"
          FROM f
      )`;
  const where = Prisma.sql`
      NOT d."hasUpcomingAppointment"
      AND d."dueAt" <= d."today" + ${query.withinDays}::int
      AND (d."disabledUntil" IS NULL OR d."disabledUntil" <= d."today")
      ${locationFilter}`;
  const order =
    query.sort === 'MOST_OVERDUE'
      ? Prisma.sql`d."dueAt" - d."today" ASC`
      : Prisma.sql`d."dueAt" - d."today" DESC`;
  const offset = (query.page - 1) * query.pageSize;

  const [{ total }] = await tx.$queryRaw<{ total: number }[]>`
          ${due}
          SELECT count(*)::int AS "total" FROM d WHERE ${where}`;
  const rows = await tx.$queryRaw<ReferenceSqlRow[]>`
          ${due}
          SELECT d."id" AS "recallId",
                 d."patientId",
                 d."firstName" AS "patientFirstName",
                 d."lastName" AS "patientLastName",
                 d."phone" AS "patientPhone",
                 d."phoneRegion",
                 d."reminderOptedOut",
                 d."kind",
                 d."recallTypeId",
                 d."recallTypeName",
                 d."intervalMonths",
                 d."baseDate",
                 d."dueAt",
                 (d."today" - d."dueAt")::int AS "daysOverdue",
                 d."homeLocationId" AS "locationId",
                 c."channel" AS "lastContactChannel",
                 c."outcome" AS "lastContactOutcome",
                 c."createdAt" AS "lastContactAt"
            FROM d
            LEFT JOIN LATERAL (
              SELECT rc."channel", rc."outcome", rc."createdAt"
                FROM "recall_contacts" rc
               WHERE rc."tenantId" = d."tenantId"
                 AND rc."recallId" = d."id"
               ORDER BY rc."createdAt" DESC, rc."id" DESC
               LIMIT 1
            ) c ON true
           WHERE ${where}
           ORDER BY ${order}, d."lastName" ASC, d."firstName" ASC, d."id" ASC
           LIMIT ${query.pageSize} OFFSET ${offset}`;
  return {
    total,
    rows: rows.map((r) => ({
      recallId: r.recallId,
      patientId: r.patientId,
      patientFirstName: r.patientFirstName,
      patientLastName: r.patientLastName,
      patientPhone: r.patientPhone,
      phoneRegion: r.phoneRegion,
      reminderOptedOut: r.reminderOptedOut,
      kind: r.kind,
      recallTypeId: r.recallTypeId,
      recallTypeName: r.recallTypeName,
      intervalMonths: r.intervalMonths,
      baseDate: civilOf(r.baseDate),
      dueAt: civilOf(r.dueAt),
      daysOverdue: r.daysOverdue,
      locationId: r.locationId,
      lastContact:
        r.lastContactChannel && r.lastContactOutcome && r.lastContactAt
          ? {
              channel: r.lastContactChannel,
              outcome: r.lastContactOutcome,
              createdAt: r.lastContactAt,
            }
          : null,
    })),
  };
}
