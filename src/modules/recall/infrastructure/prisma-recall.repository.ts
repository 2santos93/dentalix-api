import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type RecallContactChannel,
  type RecallContactOutcome,
  type RecallKind,
  type RecallSource,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { RecallRepository } from '../domain/ports/recall-repository.port';
import type {
  NewRecallContact,
  PatientRecallRow,
  RecallContactView,
  RecallDueQuery,
  RecallDueRow,
  RecallRef,
  RecallTypeRef,
  RecallTypeView,
  SetPatientRecallData,
  StaffRef,
} from '../domain/recall.entity';

/** DATE de Postgres -> día civil (Prisma lo trae a medianoche UTC). */
const civilOf = (date: Date): string => date.toISOString().slice(0, 10);
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

const CONTACT_SELECT = {
  id: true,
  recallId: true,
  patientId: true,
  locationId: true,
  channel: true,
  outcome: true,
  note: true,
  appointmentId: true,
  authorId: true,
  createdAt: true,
  recall: {
    select: {
      kind: true,
      recallTypeId: true,
      recallType: { select: { name: true } },
    },
  },
} as const satisfies Prisma.RecallContactSelect;

type ContactRow = Prisma.RecallContactGetPayload<{
  select: typeof CONTACT_SELECT;
}>;

/** Columnas de una fila de la página de `recallDueSql`. */
interface DuePageColumns {
  recallId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  phoneRegion: string | null;
  reminderOptedOut: boolean;
  kind: RecallKind | null;
  recallTypeId: string;
  recallTypeName: string;
  intervalMonths: number;
  baseDate: Date;
  dueAt: Date;
  daysOverdue: number;
  locationId: string;
  lastContactChannel: RecallContactChannel | null;
  lastContactOutcome: RecallContactOutcome | null;
  lastContactAt: Date | null;
}

/**
 * Lo que devuelve `recallDueSql`: el total en cada fila y, en la fila única de
 * una página vacía (fuera de rango o sin recall), TODAS las columnas de la
 * página a NULL. `recallId === null` distingue los dos casos.
 */
type DueSqlRow = { total: number } & (
  DuePageColumns | { [K in keyof DuePageColumns]: null }
);

export interface RecallDueSqlParams extends RecallDueQuery {
  tenantId: string;
  /** Sedes del request (activa o permitidas); `undefined` = sin restricción. */
  locationIds?: readonly string[];
}

/**
 * DX-547 (DB-079) · La lista de llamada en UNA sentencia: el total y la
 * página salen de la misma evaluación de `d` (MATERIALIZED), y siempre vuelve
 * al menos una fila con el total (en una página fuera de rango, sin recall).
 *
 * DX-015-bis: el vencimiento es el GUARDADO (`dueAt`, columna generada:
 * "lastDoneAt" + intervalo), que ya no depende de la última visita. En orden:
 * 1. `c`: los recall ACTIVOS de pacientes vivos de la clínica que pueden
 *    salir, antes de las LATERAL: un RANGO sobre
 *    `patient_recalls_tenant_due_idx` ("dueAt" <= el «hoy» más adelantado de
 *    las sedes de la clínica + la ventana; `maxToday` es un InitPlan, así que
 *    la cota va en el propio recorrido del índice). «Hoy» en la sede del
 *    paciente nunca pasa de `maxToday`, así que la cota solo descarta lo que
 *    tampoco saldría después. Sin cita futura ni en la clínica
 *    (`appointments_tenant_patient_upcoming_idx`; no depende de la sede).
 * 2. `d`: la última cita atendida (appointments_tenant_patient_completed_idx)
 *    da SOLO la sede del paciente y su «hoy»; ahí se aplican el filtro exacto
 *    por ese «hoy» y el de sede, que depende de esa cita.
 * 3. El nombre del tipo y el último contacto, solo de la página.
 */
export function recallDueSql(p: RecallDueSqlParams): Prisma.Sql {
  const kindFilter = p.kind
    ? Prisma.sql`AND pr."kind" = ${p.kind}::"RecallKind"`
    : Prisma.empty;
  const typeFilter = p.recallTypeId
    ? Prisma.sql`AND pr."recallTypeId" = ${p.recallTypeId}::uuid`
    : Prisma.empty;
  const locationFilter = p.locationIds
    ? Prisma.sql`AND k."homeLocationId" = ANY(${p.locationIds}::uuid[])`
    : Prisma.empty;
  const order = (alias: Prisma.Sql) =>
    p.sort === 'MOST_OVERDUE'
      ? Prisma.sql`${alias}."dueIn" ASC, ${alias}."lastName" ASC, ${alias}."firstName" ASC, ${alias}."id" ASC`
      : Prisma.sql`${alias}."dueIn" DESC, ${alias}."lastName" ASC, ${alias}."firstName" ASC, ${alias}."id" ASC`;
  const offset = (p.page - 1) * p.pageSize;
  return Prisma.sql`
    WITH bound AS (
      SELECT max(((${p.now}::timestamptz) AT TIME ZONE coalesce(l."timeZone", 'UTC'))::date) AS "maxToday"
        FROM "locations" l
       WHERE l."tenantId" = ${p.tenantId}::uuid
    ),
    c AS MATERIALIZED (
      SELECT pr."id", pr."tenantId", pr."patientId", pr."kind", pr."recallTypeId",
             pr."intervalMonths", pr."lastDoneAt", pr."dueAt", pr."disabledUntil",
             pr."locationId",
             pa."firstName", pa."lastName", pa."phone",
             (pa."reminderOptOutAt" IS NOT NULL) AS "reminderOptedOut"
        FROM "patient_recalls" pr
        JOIN "patients" pa
          ON pa."tenantId" = pr."tenantId" AND pa."id" = pr."patientId"
       WHERE pr."tenantId" = ${p.tenantId}::uuid
         AND pr."active"
         AND pr."dueAt" <= (SELECT "maxToday" FROM bound) + ${p.withinDays}::int
         AND pa."deletedAt" IS NULL
         ${kindFilter}
         ${typeFilter}
         AND (pr."disabledUntil" IS NULL OR pr."disabledUntil" <= (SELECT "maxToday" FROM bound))
         AND NOT EXISTS (
           SELECT 1 FROM "appointments" a
            WHERE a."tenantId" = pr."tenantId"
              AND a."patientId" = pr."patientId"
              AND a."deletedAt" IS NULL
              -- El predicado del índice parcial, literal: Postgres no lo
              -- deduce del OR de abajo y sin él no usa el índice.
              AND a."status" IN ('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
              AND (
                (a."status" IN ('SCHEDULED', 'CONFIRMED') AND a."start" > ${p.now})
                OR a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
              )
         )
    ),
    d AS MATERIALIZED (
      SELECT c."id", c."tenantId", c."patientId", c."kind", c."recallTypeId",
             c."intervalMonths", c."firstName", c."lastName", c."phone",
             c."reminderOptedOut",
             k."homeLocationId", k."phoneRegion", k."today",
             c."lastDoneAt" AS "baseDate", c."dueAt", c."dueAt" - k."today" AS "dueIn"
        FROM c
        LEFT JOIN LATERAL (
          SELECT a."locationId"
            FROM "appointments" a
           WHERE a."tenantId" = c."tenantId"
             AND a."patientId" = c."patientId"
             AND a."status" = 'COMPLETED'
             AND a."deletedAt" IS NULL
           ORDER BY a."start" DESC, a."id" DESC
           LIMIT 1
        ) lc ON true
        JOIN "locations" lo
          ON lo."tenantId" = c."tenantId"
         AND lo."id" = coalesce(lc."locationId", c."locationId")
       CROSS JOIN LATERAL (
         SELECT lo."id" AS "homeLocationId",
                lo."defaultPhoneRegion" AS "phoneRegion",
                ((${p.now}::timestamptz) AT TIME ZONE coalesce(lo."timeZone", 'UTC'))::date AS "today"
       ) k
       WHERE c."dueAt" <= k."today" + ${p.withinDays}::int
         AND (c."disabledUntil" IS NULL OR c."disabledUntil" <= k."today")
         ${locationFilter}
    ),
    page AS (
      SELECT d.* FROM d
       ORDER BY ${order(Prisma.raw('d'))}
       LIMIT ${p.pageSize} OFFSET ${offset}
    )
    SELECT t."total",
           pg."id" AS "recallId",
           pg."patientId",
           pg."firstName" AS "patientFirstName",
           pg."lastName" AS "patientLastName",
           pg."phone" AS "patientPhone",
           pg."phoneRegion",
           pg."reminderOptedOut",
           pg."kind",
           pg."recallTypeId",
           rt."name" AS "recallTypeName",
           pg."intervalMonths",
           pg."baseDate",
           pg."dueAt",
           (pg."today" - pg."dueAt")::int AS "daysOverdue",
           pg."homeLocationId" AS "locationId",
           rc."channel" AS "lastContactChannel",
           rc."outcome" AS "lastContactOutcome",
           rc."createdAt" AS "lastContactAt"
      FROM (SELECT count(*)::int AS "total" FROM d) t
      LEFT JOIN page pg ON true
      LEFT JOIN "recall_types" rt
        ON rt."tenantId" = pg."tenantId" AND rt."id" = pg."recallTypeId"
      LEFT JOIN LATERAL (
        SELECT x."channel", x."outcome", x."createdAt"
          FROM "recall_contacts" x
         WHERE x."tenantId" = pg."tenantId"
           AND x."recallId" = pg."id"
         ORDER BY x."createdAt" DESC, x."id" DESC
         LIMIT 1
      ) rc ON true
     ORDER BY ${order(Prisma.raw('pg'))}`;
}

/**
 * DX-015 · Recall sobre Prisma. DX-015-bis: el vencimiento es la columna
 * generada `dueAt` y la base la mantiene `dx_recall_recompute` (lo fijado a
 * mano o el último DONE de un procedimiento disparador del tipo).
 */
@Injectable()
export class PrismaRecallRepository implements RecallRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Los recalls de pacientes con su tipo, su sede (la de la última cita
   * atendida o, sin ella, la del recall), hoy en la zona de esa sede, la base
   * y el vencimiento guardado. `extra` acota (paciente, recall).
   */
  private recallFacts(now: Date, extra: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      SELECT pr."id", pr."tenantId", pr."patientId", pr."kind",
             pr."recallTypeId", rt."name" AS "recallTypeName", rt."sortOrder",
             pr."intervalMonths", pr."lastDoneAt", pr."dueAt", pr."manualDoneAt",
             pr."lastDoneItemId", pr."source", pr."preBackfillDoneAt",
             pr."active", pr."disabledUntil",
             pr."disabledReason", pr."updatedAt", pr."updatedById",
             pa."firstName", pa."lastName", pa."phone",
             (pa."reminderOptOutAt" IS NOT NULL) AS "reminderOptedOut",
             lo."id" AS "homeLocationId",
             lo."defaultPhoneRegion" AS "phoneRegion",
             ((${now}::timestamptz) AT TIME ZONE coalesce(lo."timeZone", 'UTC'))::date AS "today",
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
        -- Última cita atendida (appointments_tenant_patient_completed_idx):
        -- solo la sede del paciente.
        LEFT JOIN LATERAL (
          SELECT a."locationId"
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

  async listDue(
    query: RecallDueQuery,
  ): Promise<{ rows: RecallDueRow[]; total: number }> {
    // La sede del request o, sin ella, las permitidas al miembro (DX-089).
    const sql = recallDueSql({
      ...query,
      tenantId: this.tenantId(),
      locationIds: this.tenantContext.scopeLocationIds(),
    });
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<DueSqlRow[]>(sql);
      return {
        total: rows[0]?.total ?? 0,
        rows: rows.flatMap((r) =>
          r.recallId === null
            ? []
            : [
                {
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
                    r.lastContactChannel &&
                    r.lastContactOutcome &&
                    r.lastContactAt
                      ? {
                          channel: r.lastContactChannel,
                          outcome: r.lastContactOutcome,
                          createdAt: r.lastContactAt,
                        }
                      : null,
                },
              ],
        ),
      };
    });
  }

  patientExists(patientId: string): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const found = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { id: true },
      });
      return found !== null;
    });
  }

  async patientRecalls(
    patientId: string,
    now: Date,
  ): Promise<{ rows: PatientRecallRow[]; contacts: RecallContactView[] }> {
    return this.prisma.runWithTenant(async (tx) => {
      const facts = await tx.$queryRaw<
        {
          id: string;
          kind: RecallKind | null;
          recallTypeId: string;
          recallTypeName: string;
          intervalMonths: number;
          lastDoneAt: Date;
          dueAt: Date;
          manualDoneAt: Date | null;
          lastDoneItemId: string | null;
          source: RecallSource;
          preBackfillDoneAt: Date | null;
          active: boolean;
          disabledUntil: Date | null;
          disabledReason: string | null;
          homeLocationId: string;
          today: Date;
          hasUpcomingAppointment: boolean;
          updatedAt: Date;
          updatedById: string;
        }[]
      >`${this.recallFacts(now, Prisma.sql`AND pr."patientId" = ${patientId}::uuid`)}
        ORDER BY rt."sortOrder" ASC, rt."name" ASC, pr."id" ASC`;
      const contactRows = await tx.recallContact.findMany({
        where: { patientId },
        select: CONTACT_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
      const names = await this.staffNames(tx, [
        ...facts.map((f) => f.updatedById),
        ...contactRows.map((c) => c.authorId),
      ]);
      return {
        rows: facts.map((f) => ({
          id: f.id,
          kind: f.kind,
          recallTypeId: f.recallTypeId,
          recallTypeName: f.recallTypeName,
          intervalMonths: f.intervalMonths,
          lastDoneAt: civilOf(f.lastDoneAt),
          dueAt: civilOf(f.dueAt),
          manualDoneAt: f.manualDoneAt ? civilOf(f.manualDoneAt) : null,
          lastDoneItemId: f.lastDoneItemId,
          source: f.source,
          preBackfillDoneAt: f.preBackfillDoneAt
            ? civilOf(f.preBackfillDoneAt)
            : null,
          active: f.active,
          disabledUntil: f.disabledUntil ? civilOf(f.disabledUntil) : null,
          disabledReason: f.disabledReason,
          locationId: f.homeLocationId,
          hasUpcomingAppointment: f.hasUpcomingAppointment,
          today: civilOf(f.today),
          updatedAt: f.updatedAt,
          updatedById: f.updatedById,
        })),
        contacts: contactRows.map((c) => this.toContact(c, names)),
      };
    });
  }

  writeToday(now: Date): Promise<string> {
    return this.prisma.runWithTenant(async (tx) => {
      const locationId = await this.tenantContext.writeLocationId(tx);
      const location = await tx.location.findFirstOrThrow({
        where: { id: locationId },
        select: { id: true, timeZone: true },
      });
      return civilDateIn(now, requireLocationTimeZone(location));
    });
  }

  /**
   * DX-015-bis: crea o cambia el único recall del paciente de ese tipo y
   * recalcula su base en la MISMA transacción: lo fijado va a "manualDoneAt"
   * y "lastDoneAt" queda en el máximo con el último DONE de un disparador
   * (`dx_recall_recompute`). El alta va a la sede de trabajo.
   */
  upsertRecall(data: SetPatientRecallData): Promise<{ id: string }> {
    return this.prisma.runWithTenant(async (tx) => {
      const tenantId = this.tenantId();
      const manualDoneAt = dateOf(data.manualDoneAt);
      const fields = {
        // Compatibilidad (D7): la clave del tipo, si tiene.
        kind: data.recallType.systemKey,
        intervalMonths: data.intervalMonths,
        manualDoneAt,
        lastDoneAt: manualDoneAt,
        // Lo fijado ahora es de verdad del clínico (ya no la base congelada).
        preBackfillDoneAt: null,
        active: data.active,
        disabledUntil: data.disabledUntil ? dateOf(data.disabledUntil) : null,
        disabledReason: data.disabledUntil ? data.disabledReason : null,
        updatedById: data.actorId,
      };
      const existing = await tx.patientRecall.findFirst({
        where: { patientId: data.patientId, recallTypeId: data.recallType.id },
        select: { id: true },
      });
      const row = existing
        ? await tx.patientRecall.update({
            where: { id: existing.id },
            data: fields,
            select: { id: true },
          })
        : await tx.patientRecall.create({
            data: {
              tenantId,
              patientId: data.patientId,
              recallTypeId: data.recallType.id,
              locationId: await this.tenantContext.writeLocationId(tx),
              createdById: data.actorId,
              source: 'MANUAL',
              ...fields,
            },
            select: { id: true },
          });
      await tx.$executeRaw`SELECT public.dx_recall_recompute(${tenantId}::uuid, ${data.patientId}::uuid, ${data.recallType.id}::uuid)`;
      return row;
    });
  }

  /**
   * DX-015-bis: el tipo vivo con esa clave del enum o ese id; null si no hay.
   * Vale también uno desactivado, a propósito: sus recalls ya existentes se
   * siguen pausando, retirando o corrigiendo a mano (desactivar el tipo solo
   * deja de crearlos por procedimiento).
   */
  findType(
    ref: { systemKey: RecallKind } | { id: string },
  ): Promise<RecallTypeRef | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.recallType.findFirst({
        where: {
          deletedAt: null,
          ...('id' in ref ? { id: ref.id } : { systemKey: ref.systemKey }),
        },
        select: { id: true, systemKey: true },
      }),
    );
  }

  /** DX-015-bis: los tipos vivos de la clínica (activos o no), en su orden. */
  listTypes(): Promise<RecallTypeView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.recallType.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          name: true,
          defaultIntervalMonths: true,
          active: true,
          sortOrder: true,
          systemKey: true,
          exclusionGroup: true,
          triggers: {
            select: { catalogItemId: true },
            orderBy: { catalogItemId: 'asc' },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      });
      return rows.map(({ triggers, ...type }) => ({
        ...type,
        triggerCatalogItemIds: triggers.map((t) => t.catalogItemId),
      }));
    });
  }

  async findRecall(recallId: string): Promise<RecallRef | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // La sede sale de la MISMA consulta que la lista: quien no puede ver a
      // este paciente en la lista tampoco puede registrarle un contacto.
      const rows = await tx.$queryRaw<
        {
          id: string;
          patientId: string;
          kind: RecallKind | null;
          homeLocationId: string;
        }[]
      >`${this.recallFacts(
        new Date(),
        Prisma.sql`AND pr."id" = ${recallId}::uuid AND pa."deletedAt" IS NULL`,
      )}`;
      const row = rows[0];
      return row
        ? {
            id: row.id,
            patientId: row.patientId,
            kind: row.kind,
            locationId: row.homeLocationId,
          }
        : null;
    });
  }

  appointmentOfPatient(
    appointmentId: string,
    patientId: string,
  ): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const found = await tx.appointment.findFirst({
        where: { id: appointmentId, patientId, deletedAt: null },
        select: { id: true },
      });
      return found !== null;
    });
  }

  createContact(data: NewRecallContact): Promise<RecallContactView> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.recallContact.create({
        data: { tenantId: this.tenantId(), ...data },
        select: CONTACT_SELECT,
      });
      return this.toContact(row, await this.staffNames(tx, [row.authorId]));
    });
  }

  staff(ids: readonly string[]): Promise<Map<string, StaffRef>> {
    return this.prisma.runWithTenant(async (tx) => {
      const names = await this.staffNames(tx, ids);
      return new Map(
        ids.map((id) => [id, { id, fullName: names.get(id) ?? null }]),
      );
    });
  }

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('Sin tenant en el contexto del request.');
    return tenantId;
  }

  /** Nombre de cada miembro de la clínica (bajo RLS), en una consulta. */
  private async staffNames(
    tx: Prisma.TransactionClient,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const members = await tx.clinicMembership.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, user: { select: { fullName: true } } },
    });
    return new Map(members.map((m) => [m.userId, m.user.fullName]));
  }

  private toContact(
    row: ContactRow,
    names: Map<string, string>,
  ): RecallContactView {
    return {
      id: row.id,
      recallId: row.recallId,
      kind: row.recall.kind,
      recallTypeId: row.recall.recallTypeId,
      recallTypeName: row.recall.recallType.name,
      patientId: row.patientId,
      locationId: row.locationId,
      channel: row.channel,
      outcome: row.outcome,
      note: row.note,
      appointmentId: row.appointmentId,
      author: { id: row.authorId, fullName: names.get(row.authorId) ?? null },
      createdAt: row.createdAt,
    };
  }
}
