import { ConflictException, Injectable } from '@nestjs/common';
import { ClinicRole, DocumentType, Prisma, Sex } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { insertPatientRowInTx } from '../../patients/infrastructure/repositories/prisma-patient.repository';
import { phoneTakenError } from '../application/lead-errors';
import {
  LEAD_MESSAGES,
  LEAD_STAGES,
  type LeadReasonKindCode,
  type LeadStageCode,
} from '../domain/lead-rules';
import type {
  ConvertDecision,
  ConvertResult,
  CreateLeadRepoInput,
  LeadBoardColumn,
  LeadListFilter,
  LeadLocationScope,
  LeadNoteRow,
  LeadPage,
  LeadPhoneMatch,
  LeadReasonRow,
  LeadReportRow,
  LeadRepository,
  LeadRow,
  LockedLead,
  PhoneOwners,
  StageChange,
  UpdateLeadPatch,
} from '../domain/lead-repository.port';

type Tx = Prisma.TransactionClient;

/** «Ahora» de la BD en UTC (las columnas son TIMESTAMP sin zona, en UTC). */
const NOW = Prisma.sql`pg_catalog.timezone('UTC', pg_catalog.now())`;

/** «Sin contactar hace más de 24 h» (lead-rules.ts `isStale`), con la hora de la BD. */
const STALE = Prisma.sql`(
  l."stage" IN ('NEW', 'CONTACTED') AND l."anonymizedAt" IS NULL
  AND coalesce(l."lastContactAt", l."createdAt") <= ${NOW} - interval '24 hours'
  AND (l."nextActionAt" IS NULL OR l."nextActionAt" <= ${NOW})
)`;

const ROW_COLUMNS = Prisma.sql`
  l."id", l."locationId", loc."name" AS "locationName", l."fullName", l."phone",
  l."phoneE164", l."channel"::text AS "channel", l."interestReason",
  l."stage"::text AS "stage", l."lostReason", l."ownerId", u."fullName" AS "ownerName",
  l."nextActionAt", l."nextActionNote", l."lastContactAt", l."scheduledAt",
  l."attendedAt", l."lostAt", l."convertedPatientId", l."convertedAt",
  l."firstAppointmentId", l."anonymizedAt", l."createdById", l."createdAt",
  l."updatedAt", ${STALE} AS "stale"`;

const ROW_FROM = Prisma.sql`
  FROM "leads" l
  JOIN "locations" loc ON loc."tenantId" = l."tenantId" AND loc."id" = l."locationId"
  LEFT JOIN "users" u ON u."id" = l."ownerId"`;

/** Comodines de LIKE escapados. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return true;
    const meta = error.meta as { code?: string } | undefined;
    if (error.code === 'P2010' && meta?.code === '23505') return true;
  }
  return false;
}

function userDraft(
  audit: AuditRequestContext,
  event: Pick<
    AuditEventDraft,
    'action' | 'resourceType' | 'resourceId' | 'metadata' | 'patient'
  >,
): AuditEventDraft {
  return {
    tenantId: audit.tenantId,
    locationId: audit.locationId,
    actor: {
      kind: 'user',
      userId: audit.actor.userId,
      role: audit.actor.role,
    },
    requestId: audit.requestId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    ...event,
  };
}

@Injectable()
export class PrismaLeadRepository implements LeadRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async locationExists(locationId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { id: locationId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  writeLocationId(): Promise<string> {
    return this.prisma.runWithTenant((tx) =>
      this.tenantContext.writeLocationId(tx),
    );
  }

  async phoneRegionOf(locationId: string): Promise<string | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { id: locationId },
        select: { defaultPhoneRegion: true },
      }),
    );
    return row?.defaultPhoneRegion ?? null;
  }

  async isEligibleOwner(userId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.findFirst({
        where: {
          userId,
          deletedAt: null,
          role: { in: [ClinicRole.ADMIN, ClinicRole.RECEPTION] },
        },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  owners(): Promise<{ userId: string; fullName: string; role: string }[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.clinicMembership.findMany({
        where: {
          deletedAt: null,
          role: { in: [ClinicRole.ADMIN, ClinicRole.RECEPTION] },
        },
        select: {
          userId: true,
          role: true,
          user: { select: { fullName: true } },
        },
      });
      return rows
        .map((r) => ({
          userId: r.userId,
          fullName: r.user.fullName,
          role: r.role as string,
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'es'));
    });
  }

  phoneOwners(phoneE164: string, excludeLeadId?: string): Promise<PhoneOwners> {
    return this.prisma.runWithTenant((tx) =>
      this.phoneOwnersIn(tx, phoneE164, excludeLeadId),
    );
  }

  private async phoneOwnersIn(
    tx: Tx,
    phoneE164: string,
    excludeLeadId?: string,
  ): Promise<PhoneOwners> {
    const [patients, lead] = await Promise.all([
      tx.patient.findMany({
        where: { phoneE164, deletedAt: null, mergedIntoId: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 5,
        select: { id: true, firstName: true, lastName: true },
      }),
      tx.lead.findFirst({
        where: {
          phoneE164,
          ...(excludeLeadId ? { id: { not: excludeLeadId } } : {}),
        },
        select: { id: true, fullName: true, locationId: true },
      }),
    ]);
    return { patients, lead };
  }

  private async rowIn(tx: Tx, tenantId: string, id: string): Promise<LeadRow> {
    const [row] = await tx.$queryRaw<LeadRow[]>`
      SELECT ${ROW_COLUMNS} ${ROW_FROM}
       WHERE l."tenantId" = ${tenantId}::uuid AND l."id" = ${id}::uuid`;
    return row;
  }

  private async lock(tx: Tx, id: string): Promise<LockedLead | null> {
    const [row] = await tx.$queryRaw<LockedLead[]>`
      SELECT "id", "locationId", "stage"::text AS "stage", "phone", "phoneE164",
             "fullName", "convertedPatientId", "anonymizedAt"
        FROM "leads" WHERE "id" = ${id}::uuid
       FOR UPDATE`;
    return row ?? null;
  }

  async create(
    input: CreateLeadRepoInput,
    audit: AuditRequestContext,
  ): Promise<LeadRow> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const created = await tx.lead.create({
          data: {
            tenantId,
            locationId: input.locationId,
            fullName: input.fullName,
            phone: input.phone,
            phoneE164: input.phoneE164,
            channel: input.channel,
            interestReason: input.interestReason,
            ownerId: input.ownerId,
            nextActionAt: input.nextActionAt,
            nextActionNote: input.nextActionNote,
            createdById: input.createdById,
          },
          select: { id: true },
        });
        // Ni el nombre ni el teléfono van a la auditoría: solo el id, la sede
        // (en el contexto) y el motivo.
        await writeAuditEvent(
          tx,
          userDraft(audit, {
            action: 'CREATE',
            resourceType: 'LEAD',
            resourceId: created.id,
            patient: null,
            metadata: { reason: 'LEAD_CREATED' },
          }),
        );
        return this.rowIn(tx, tenantId, created.id);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Otra alta con el mismo número ganó la carrera (leads_tenant_phone_key).
      const owners = await this.phoneOwners(input.phoneE164);
      throw phoneTakenError({
        kind: 'LEAD',
        id: owners.lead?.id ?? null,
        name: owners.lead?.fullName ?? null,
      });
    }
  }

  async findById(id: string): Promise<LeadRow | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      this.rowIn(tx, tenantId, id),
    );
    return row ?? null;
  }

  notes(id: string): Promise<LeadNoteRow[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<LeadNoteRow[]>`
        SELECT n."id", n."body", n."authorId", u."fullName" AS "authorName", n."createdAt"
          FROM "lead_notes" n
          LEFT JOIN "users" u ON u."id" = n."authorId"
         WHERE n."tenantId" = ${tenantId}::uuid AND n."leadId" = ${id}::uuid
         ORDER BY n."createdAt" DESC, n."id" DESC`,
    );
  }

  async update(
    id: string,
    patch: UpdateLeadPatch,
    decide: (locked: LockedLead) => void,
    changedFields: string[],
    audit: AuditRequestContext,
  ): Promise<LeadRow | null> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const locked = await this.lock(tx, id);
        if (!locked) return null;
        decide(locked);
        await tx.lead.update({ where: { id }, data: patch });
        await writeAuditEvent(
          tx,
          userDraft(audit, {
            action: 'UPDATE',
            resourceType: 'LEAD',
            resourceId: id,
            patient: locked.convertedPatientId
              ? { kind: 'patient', id: locked.convertedPatientId }
              : null,
            metadata: { reason: 'LEAD_UPDATED', changedFields },
          }),
        );
        return this.rowIn(tx, tenantId, id);
      });
    } catch (error) {
      if (!isUniqueViolation(error) || !patch.phoneE164) throw error;
      const owners = await this.phoneOwners(patch.phoneE164, id);
      throw phoneTakenError({
        kind: 'LEAD',
        id: owners.lead?.id ?? null,
        name: owners.lead?.fullName ?? null,
      });
    }
  }

  changeStage(
    id: string,
    decide: (locked: LockedLead) => StageChange,
    audit: AuditRequestContext,
  ): Promise<LeadRow | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await this.lock(tx, id);
      if (!locked) return null;
      const change = decide(locked);
      const to = change.to;
      await tx.$executeRaw`
        UPDATE "leads" SET
          "stage" = ${to}::"LeadStage",
          "lostReason" = ${to === 'LOST' ? change.lostReason : null},
          "lostAt" = CASE WHEN ${to} = 'LOST' THEN ${NOW} ELSE NULL END,
          "lastContactAt" = CASE WHEN ${to} = 'CONTACTED' THEN ${NOW} ELSE "lastContactAt" END,
          "updatedAt" = ${NOW}
        WHERE "id" = ${id}::uuid`;
      await writeAuditEvent(
        tx,
        userDraft(audit, {
          action: 'UPDATE',
          resourceType: 'LEAD',
          resourceId: id,
          patient: locked.convertedPatientId
            ? { kind: 'patient', id: locked.convertedPatientId }
            : null,
          metadata: {
            reason: 'LEAD_STAGE_CHANGED',
            statusChange: { from: locked.stage, to },
          },
        }),
      );
      return this.rowIn(tx, tenantId, id);
    });
  }

  addNote(
    id: string,
    body: string,
    decide: (locked: LockedLead) => void,
    audit: AuditRequestContext,
  ): Promise<LeadNoteRow | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await this.lock(tx, id);
      if (!locked) return null;
      decide(locked);
      const note = await tx.leadNote.create({
        data: { tenantId, leadId: id, body, authorId: audit.actor.userId },
        select: { id: true },
      });
      // Una nota es un contacto (sale de «sin contactar»).
      await tx.$executeRaw`
        UPDATE "leads" SET "lastContactAt" = ${NOW}, "updatedAt" = ${NOW}
         WHERE "id" = ${id}::uuid`;
      // El texto de la nota nunca va a la auditoría.
      await writeAuditEvent(
        tx,
        userDraft(audit, {
          action: 'UPDATE',
          resourceType: 'LEAD',
          resourceId: id,
          patient: locked.convertedPatientId
            ? { kind: 'patient', id: locked.convertedPatientId }
            : null,
          metadata: { reason: 'LEAD_NOTE_ADDED', params: { noteId: note.id } },
        }),
      );
      const [row] = await tx.$queryRaw<LeadNoteRow[]>`
        SELECT n."id", n."body", n."authorId", u."fullName" AS "authorName", n."createdAt"
          FROM "lead_notes" n LEFT JOIN "users" u ON u."id" = n."authorId"
         WHERE n."id" = ${note.id}::uuid`;
      return row;
    });
  }

  convert(
    id: string,
    decide: (
      locked: LockedLead,
      candidates: PhoneOwners['patients'],
    ) => ConvertDecision,
    audit: AuditRequestContext,
  ): Promise<ConvertResult | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // FOR UPDATE: dos «Convertir» a la vez se ordenan aquí; el segundo ve
      // el paciente que dejó el primero y lo devuelve (idempotente).
      const locked = await this.lock(tx, id);
      if (!locked) return null;
      const candidates = locked.phoneE164
        ? (await this.phoneOwnersIn(tx, locked.phoneE164, id)).patients
        : [];
      const decision = decide(locked, candidates);
      if (decision.kind === 'EXISTING') {
        return { patientId: decision.patientId, created: false, linked: false };
      }
      let patientId: string;
      if (decision.kind === 'CREATE') {
        // La ficha mínima: nombre y teléfono, sin datos clínicos (como la
        // reserva online). El teléfono se lee con el prefijo de la sede del
        // prospecto.
        const created = await insertPatientRowInTx(
          tx,
          tenantId,
          {
            firstName: decision.firstName,
            lastName: decision.lastName,
            docType: DocumentType.OTHER,
            docTypeLabel: null,
            sex: Sex.UNSPECIFIED,
            phone: locked.phone ?? undefined,
            createdById: audit.actor.userId,
          },
          undefined,
          locked.locationId,
        );
        patientId = created.id;
        await writeAuditEvent(
          tx,
          userDraft(audit, {
            action: 'CREATE',
            resourceType: 'PATIENT',
            resourceId: patientId,
            patient: { kind: 'patient', id: patientId },
            metadata: { reason: 'LEAD_CONVERTED', params: { leadId: id } },
          }),
        );
      } else {
        patientId = decision.patientId;
      }
      await tx.$executeRaw`
        UPDATE "leads" SET
          "convertedPatientId" = ${patientId}::uuid,
          "convertedAt" = ${NOW},
          "convertedById" = ${audit.actor.userId}::uuid,
          "updatedAt" = ${NOW}
        WHERE "id" = ${id}::uuid`;
      await writeAuditEvent(
        tx,
        userDraft(audit, {
          action: 'UPDATE',
          resourceType: 'LEAD',
          resourceId: id,
          patient: { kind: 'patient', id: patientId },
          metadata: {
            reason:
              decision.kind === 'CREATE' ? 'LEAD_CONVERTED' : 'LEAD_LINKED',
          },
        }),
      );
      return {
        patientId,
        created: decision.kind === 'CREATE',
        linked: decision.kind === 'LINK',
      };
    });
  }

  private where(tenantId: string, filter: Partial<LeadListFilter>): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`l."tenantId" = ${tenantId}::uuid`];
    if (filter.locationIds) {
      conds.push(
        Prisma.sql`l."locationId" = ANY(${[...filter.locationIds]}::uuid[])`,
      );
    }
    if (filter.stage) {
      conds.push(Prisma.sql`l."stage" = ${filter.stage}::"LeadStage"`);
    }
    if (filter.channel) {
      conds.push(Prisma.sql`l."channel" = ${filter.channel}::"LeadChannel"`);
    }
    if (filter.ownerId) {
      conds.push(Prisma.sql`l."ownerId" = ${filter.ownerId}::uuid`);
    }
    if (filter.createdFrom) {
      conds.push(Prisma.sql`l."createdAt" >= ${filter.createdFrom}`);
    }
    if (filter.createdTo) {
      conds.push(Prisma.sql`l."createdAt" < ${filter.createdTo}`);
    }
    if (filter.reached === 'SCHEDULED') {
      conds.push(Prisma.sql`l."scheduledAt" IS NOT NULL`);
    } else if (filter.reached === 'ATTENDED') {
      conds.push(Prisma.sql`l."attendedAt" IS NOT NULL`);
    }
    if (filter.stale) conds.push(STALE);
    const q = filter.q?.trim();
    if (q) {
      const name = `%${likeEscape(q)}%`;
      const digits = q.replace(/\D/g, '');
      conds.push(
        digits.length >= 3
          ? Prisma.sql`(public.dx_search_normalize(l."fullName") LIKE public.dx_search_normalize(${name})
                        OR l."phoneE164" LIKE ${`%${digits}%`})`
          : Prisma.sql`public.dx_search_normalize(l."fullName") LIKE public.dx_search_normalize(${name})`,
      );
    }
    return Prisma.join(conds, ' AND ');
  }

  list(
    filter: LeadListFilter,
    page: { page: number; pageSize: number },
  ): Promise<LeadPage> {
    const tenantId = this.tenantId();
    const where = this.where(tenantId, filter);
    const offset = (page.page - 1) * page.pageSize;
    return this.prisma.runWithTenant(async (tx) => {
      const [{ total }] = await tx.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS "total" FROM "leads" l WHERE ${where}`;
      const rows = await tx.$queryRaw<LeadRow[]>`
        SELECT ${ROW_COLUMNS} ${ROW_FROM}
         WHERE ${where}
         ORDER BY l."createdAt" DESC, l."id" DESC
         LIMIT ${page.pageSize} OFFSET ${offset}`;
      return { rows, total };
    });
  }

  board(
    filter: Omit<LeadListFilter, 'stage' | 'stale' | 'reached'>,
    perStage: number,
  ): Promise<LeadBoardColumn[]> {
    const tenantId = this.tenantId();
    const where = this.where(tenantId, filter);
    return this.prisma.runWithTenant(async (tx) => {
      const totals = await tx.$queryRaw<
        { stage: LeadStageCode; total: number }[]
      >`
        SELECT l."stage"::text AS "stage", count(*)::int AS "total"
          FROM "leads" l WHERE ${where} GROUP BY l."stage"`;
      // Los primeros de cada columna: los abiertos por la próxima acción
      // (la más urgente arriba), el resto por alta más reciente.
      const rows = await tx.$queryRaw<(LeadRow & { rn: number })[]>`
        SELECT * FROM (
          SELECT ${ROW_COLUMNS},
                 row_number() OVER (
                   PARTITION BY l."stage"
                   ORDER BY l."nextActionAt" ASC NULLS LAST, l."createdAt" DESC, l."id" DESC
                 )::int AS "rn"
            ${ROW_FROM}
           WHERE ${where}
        ) t
        WHERE t."rn" <= ${perStage}
        ORDER BY t."stage", t."rn"`;
      return LEAD_STAGES.map((stage) => ({
        stage,
        total: totals.find((t) => t.stage === stage)?.total ?? 0,
        rows: rows
          .filter((r) => r.stage === stage)
          .map(({ rn: _rn, ...row }) => row),
      }));
    });
  }

  count(
    locationIds: LeadLocationScope,
  ): Promise<{ open: number; stale: number }> {
    const tenantId = this.tenantId();
    const where = this.where(tenantId, { locationIds });
    return this.prisma.runWithTenant(async (tx) => {
      const [row] = await tx.$queryRaw<{ open: number; stale: number }[]>`
        SELECT count(*) FILTER (WHERE l."stage" IN ('NEW', 'CONTACTED'))::int AS "open",
               count(*) FILTER (WHERE ${STALE})::int AS "stale"
          FROM "leads" l
         WHERE ${where} AND l."stage" IN ('NEW', 'CONTACTED')`;
      return { open: row?.open ?? 0, stale: row?.stale ?? 0 };
    });
  }

  report(
    filter: Pick<LeadListFilter, 'locationIds' | 'createdFrom' | 'createdTo'>,
    by: 'channel' | 'owner',
  ): Promise<LeadReportRow[]> {
    const tenantId = this.tenantId();
    const where = this.where(tenantId, filter);
    return this.prisma.runWithTenant((tx) =>
      by === 'channel'
        ? tx.$queryRaw<LeadReportRow[]>`
            SELECT l."channel"::text AS "key", NULL::text AS "label",
                   count(*)::int AS "leads",
                   count(l."scheduledAt")::int AS "scheduled",
                   count(l."attendedAt")::int AS "attended"
              FROM "leads" l
             WHERE ${where}
             GROUP BY l."channel"
             ORDER BY count(*) DESC, l."channel"`
        : tx.$queryRaw<LeadReportRow[]>`
            SELECT l."ownerId"::text AS "key", u."fullName" AS "label",
                   count(*)::int AS "leads",
                   count(l."scheduledAt")::int AS "scheduled",
                   count(l."attendedAt")::int AS "attended"
              FROM "leads" l
              LEFT JOIN "users" u ON u."id" = l."ownerId"
             WHERE ${where}
             GROUP BY l."ownerId", u."fullName"
             ORDER BY count(*) DESC, u."fullName" NULLS LAST`,
    );
  }

  findByPhoneE164(
    e164s: readonly string[],
    locationIds: LeadLocationScope,
  ): Promise<LeadPhoneMatch[]> {
    return this.prisma.runWithTenant((tx) =>
      tx.lead.findMany({
        where: {
          phoneE164: { in: [...e164s] },
          ...(locationIds ? { locationId: { in: [...locationIds] } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 5,
        select: {
          id: true,
          fullName: true,
          stage: true,
          locationId: true,
          convertedPatientId: true,
        },
      }),
    );
  }

  reasons(kind?: LeadReasonKindCode): Promise<LeadReasonRow[]> {
    return this.prisma.runWithTenant((tx) =>
      tx.leadReason.findMany({
        where: { deletedAt: null, ...(kind ? { kind } : {}) },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
        select: { id: true, kind: true, name: true },
      }),
    );
  }

  async createReason(
    kind: LeadReasonKindCode,
    name: string,
    createdById: string,
  ): Promise<LeadReasonRow> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant((tx) =>
        tx.leadReason.create({
          data: { tenantId, kind, name, createdById },
          select: { id: true, kind: true, name: true },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(LEAD_MESSAGES.reasonTaken);
      }
      throw error;
    }
  }

  async deleteReason(id: string): Promise<boolean> {
    const { count } = await this.prisma.runWithTenant((tx) =>
      tx.leadReason.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      }),
    );
    return count > 0;
  }

  async retentionMonths(): Promise<number> {
    const tenantId = this.tenantId();
    // `tenants` no tiene RLS: se lee por el id del contexto.
    const row = await this.prisma.runWithTenant((tx) =>
      tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { leadLostRetentionMonths: true },
      }),
    );
    return row.leadLostRetentionMonths;
  }

  async setRetentionMonths(months: number): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant((tx) =>
      tx.tenant.update({
        where: { id: tenantId },
        data: { leadLostRetentionMonths: months },
        select: { id: true },
      }),
    );
  }
}
