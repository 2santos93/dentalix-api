import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type RecallContactChannel,
  type RecallContactOutcome,
  type RecallKind,
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
  recall: { select: { kind: true } },
} as const satisfies Prisma.RecallContactSelect;

type ContactRow = Prisma.RecallContactGetPayload<{
  select: typeof CONTACT_SELECT;
}>;

interface DueSqlRow {
  recallId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  phoneRegion: string | null;
  reminderOptedOut: boolean;
  kind: RecallKind;
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
 * DX-015 · Recall sobre Prisma. La lista hace en SQL la misma cuenta que
 * `recallState` (domain/recall-rules.ts): vencimiento = MAX(lastDoneAt, día de
 * la última cita atendida en la zona de la sede del paciente) + intervalo en
 * meses (`make_interval` recorta a fin de mes igual que `addCivilMonths`).
 */
@Injectable()
export class PrismaRecallRepository implements RecallRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Los recalls ACTIVOS de pacientes vivos, con su sede (la de la última cita
   * atendida o, sin ella, la del recall), hoy en la zona de esa sede, la base
   * y el vencimiento. `extra` acota (paciente, tipo, sin cita futura).
   */
  private recallFacts(now: Date, extra: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      SELECT pr."id", pr."tenantId", pr."patientId", pr."kind", pr."intervalMonths",
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
        -- Última cita atendida (appointments_tenant_patient_completed_idx).
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

  async listDue(
    query: RecallDueQuery,
  ): Promise<{ rows: RecallDueRow[]; total: number }> {
    // La sede del request o, sin ella, las permitidas al miembro (DX-089).
    const scopeIds = this.tenantContext.scopeLocationIds();
    const locationFilter = scopeIds
      ? Prisma.sql`AND d."homeLocationId" = ANY(${scopeIds}::uuid[])`
      : Prisma.empty;
    const kindFilter = query.kind
      ? Prisma.sql`AND pr."kind" = ${query.kind}::"RecallKind"`
      : Prisma.empty;
    const facts = this.recallFacts(
      query.now,
      Prisma.sql`AND pr."active" AND pa."deletedAt" IS NULL ${kindFilter}`,
    );
    const due = Prisma.sql`
      WITH f AS (${facts}),
      d AS (
        SELECT f.*,
               greatest(f."lastDoneAt", f."lastCompletedVisit") AS "baseDate",
               (greatest(f."lastDoneAt", f."lastCompletedVisit")
                 + make_interval(months => f."intervalMonths"))::date AS "dueAt"
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

    return this.prisma.runWithTenant(
      async (tx) => {
        const [{ total }] = await tx.$queryRaw<{ total: number }[]>`
          ${due}
          SELECT count(*)::int AS "total" FROM d WHERE ${where}`;
        const rows = await tx.$queryRaw<DueSqlRow[]>`
          ${due}
          SELECT d."id" AS "recallId",
                 d."patientId",
                 d."firstName" AS "patientFirstName",
                 d."lastName" AS "patientLastName",
                 d."phone" AS "patientPhone",
                 d."phoneRegion",
                 d."reminderOptedOut",
                 d."kind",
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
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
          kind: RecallKind;
          intervalMonths: number;
          lastDoneAt: Date;
          active: boolean;
          disabledUntil: Date | null;
          disabledReason: string | null;
          homeLocationId: string;
          today: Date;
          lastCompletedVisit: Date | null;
          hasUpcomingAppointment: boolean;
          updatedAt: Date;
          updatedById: string;
        }[]
      >`${this.recallFacts(now, Prisma.sql`AND pr."patientId" = ${patientId}::uuid`)}
        ORDER BY pr."kind" ASC`;
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
          intervalMonths: f.intervalMonths,
          lastDoneAt: civilOf(f.lastDoneAt),
          active: f.active,
          disabledUntil: f.disabledUntil ? civilOf(f.disabledUntil) : null,
          disabledReason: f.disabledReason,
          locationId: f.homeLocationId,
          lastCompletedVisit: f.lastCompletedVisit
            ? civilOf(f.lastCompletedVisit)
            : null,
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

  upsertRecall(data: SetPatientRecallData): Promise<{ id: string }> {
    return this.prisma.runWithTenant(async (tx) => {
      const tenantId = this.tenantId();
      const fields = {
        intervalMonths: data.intervalMonths,
        lastDoneAt: dateOf(data.lastDoneAt),
        active: data.active,
        disabledUntil: data.disabledUntil ? dateOf(data.disabledUntil) : null,
        disabledReason: data.disabledUntil ? data.disabledReason : null,
        updatedById: data.actorId,
      };
      const existing = await tx.patientRecall.findFirst({
        where: { patientId: data.patientId, kind: data.kind },
        select: { id: true },
      });
      if (existing) {
        return tx.patientRecall.update({
          where: { id: existing.id },
          data: fields,
          select: { id: true },
        });
      }
      const locationId = await this.tenantContext.writeLocationId(tx);
      return tx.patientRecall.create({
        data: {
          tenantId,
          patientId: data.patientId,
          kind: data.kind,
          locationId,
          createdById: data.actorId,
          ...fields,
        },
        select: { id: true },
      });
    });
  }

  findRecall(
    recallId: string,
  ): Promise<{ id: string; patientId: string; kind: RecallKind } | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patientRecall.findFirst({
        where: { id: recallId, patient: { deletedAt: null } },
        select: { id: true, patientId: true, kind: true },
      }),
    );
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
