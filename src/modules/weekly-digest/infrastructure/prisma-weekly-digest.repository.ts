import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { resolveReferenceLocation } from '../../../shared/locations/reference-location';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { isValidTimeZone } from '../../../shared/time/civil-day';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { PreparedEmail } from '../../notifications/email/application/email-outbox.service';
import type {
  DigestAdmin,
  DigestClinic,
  DigestLocation,
  DigestUnsubscribeLink,
  OpenCashSession,
  SendRunInput,
  SendRunOutcome,
  WeeklyDigestRepository,
  WeeklyDigestSettings,
} from '../domain/ports/weekly-digest-repository.port';
import { uuidV7 } from '../domain/uuid-v7';
import {
  readReceivablesSnapshot,
  type ReceivablesSnapshot,
} from '../domain/weekly-digest';

/** Motivos de auditoría del resumen semanal (CLINIC_SETTINGS). */
export const WEEKLY_DIGEST_SETTINGS_REASON = 'WEEKLY_DIGEST_SETTINGS';
export const WEEKLY_DIGEST_TEST_SENT_REASON = 'WEEKLY_DIGEST_TEST_SENT';
export const WEEKLY_DIGEST_UNSUBSCRIBED_REASON = 'WEEKLY_DIGEST_UNSUBSCRIBED';

const SETTINGS_SELECT = {
  weeklyDigestEnabled: true,
  weeklyDigestWeekday: true,
  weeklyDigestHour: true,
} as const;

interface SettingsRow {
  weeklyDigestEnabled: boolean;
  weeklyDigestWeekday: number;
  weeklyDigestHour: number;
}

/** La membresía de un destinatario con su usuario (todo lo que decide si recibe). */
const MEMBER_SELECT = {
  id: true,
  role: true,
  deletedAt: true,
  user: {
    select: {
      id: true,
      fullName: true,
      email: true,
      emailVerifiedAt: true,
      deletedAt: true,
    },
  },
} as const;

type MemberRow = Prisma.ClinicMembershipGetPayload<{
  select: typeof MEMBER_SELECT;
}>;

function isActiveAdmin(m: MemberRow): boolean {
  return (
    m.role === ClinicRole.ADMIN &&
    m.deletedAt === null &&
    m.user.deletedAt === null
  );
}

function adminOf(m: MemberRow): DigestAdmin {
  return {
    membershipId: m.id,
    userId: m.user.id,
    fullName: m.user.fullName,
    email: m.user.email,
    verified: m.user.emailVerifiedAt !== null,
  };
}

/** `YYYY-MM-DD` → la fecha que Prisma escribe en una columna DATE. */
function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Lista ordenada y sin repetidos (la forma en que se audita y compara). */
function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Resumen semanal (DX-568) bajo RLS: `weekly_digest_*` y las columnas de
 * `tenants`, siempre por la clínica del contexto (la de la petición, la del
 * trabajo o la del host de la baja), con `tenantId` explícito además.
 */
@Injectable()
export class PrismaWeeklyDigestRepository implements WeeklyDigestRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  private async recipientIds(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string[]> {
    const rows = await tx.weeklyDigestRecipient.findMany({
      where: { tenantId },
      select: { membershipId: true },
    });
    return rows.map((r) => r.membershipId);
  }

  private async admins(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<MemberRow[]> {
    const rows = await tx.clinicMembership.findMany({
      where: {
        tenantId,
        role: ClinicRole.ADMIN,
        deletedAt: null,
        user: { deletedAt: null },
      },
      select: MEMBER_SELECT,
    });
    return rows.sort(
      (a, b) =>
        a.user.fullName.localeCompare(b.user.fullName, 'es', {
          sensitivity: 'base',
        }) || a.id.localeCompare(b.id),
    );
  }

  private settingsOf(
    row: SettingsRow,
    recipients: readonly string[],
  ): WeeklyDigestSettings {
    return {
      enabled: row.weeklyDigestEnabled,
      weekday: row.weeklyDigestWeekday,
      hour: row.weeklyDigestHour,
      recipientMembershipIds: sortedIds(recipients),
    };
  }

  getSettings(): Promise<WeeklyDigestSettings> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: SETTINGS_SELECT,
      });
      // Solo los que hoy son ADMIN activos: una fila de quien dejó de serlo
      // se conserva (vuelve a recibirlo si lo vuelve a ser) pero no se ve.
      const active = new Set(
        (await this.admins(tx, tenantId)).map((m) => m.id),
      );
      const ids = (await this.recipientIds(tx, tenantId)).filter((id) =>
        active.has(id),
      );
      return this.settingsOf(tenant, ids);
    });
  }

  async activeAdmins(): Promise<DigestAdmin[]> {
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      this.admins(tx, tenantId),
    );
    return rows.map(adminOf);
  }

  setSettings(
    next: WeeklyDigestSettings,
    ctx: AuditRequestContext,
  ): Promise<
    | { ok: true; before: WeeklyDigestSettings; after: WeeklyDigestSettings }
    | { ok: false; invalidMembershipIds: string[] }
  > {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // La fila de la clínica bloqueada: dos PUT a la vez no se pisan el
      // «antes» (patrón de DX-360 / DX-448).
      const [locked] = await tx.$queryRaw<SettingsRow[]>`
        SELECT "weeklyDigestEnabled", "weeklyDigestWeekday", "weeklyDigestHour"
          FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      const admins = new Set(
        (await this.admins(tx, tenantId)).map((m) => m.id),
      );
      const wanted = sortedIds(next.recipientMembershipIds);
      const invalid = wanted.filter((id) => !admins.has(id));
      if (invalid.length > 0)
        return { ok: false, invalidMembershipIds: invalid };

      const stored = await this.recipientIds(tx, tenantId);
      const before = this.settingsOf(
        locked,
        stored.filter((id) => admins.has(id)),
      );
      // Se sustituye el conjunto entre los ADMIN activos; la fila de quien
      // ya no es ADMIN no se toca (D2).
      const remove = stored.filter(
        (id) => admins.has(id) && !wanted.includes(id),
      );
      if (remove.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- DX-568: configuración sin datos de pacientes (HARD_DELETE_ALLOWLIST), auditada en la transacción.
        await tx.weeklyDigestRecipient.deleteMany({
          where: { tenantId, membershipId: { in: remove } },
        });
      }
      const add = wanted.filter((id) => !stored.includes(id));
      if (add.length > 0) {
        await tx.weeklyDigestRecipient.createMany({
          data: add.map((membershipId) => ({ tenantId, membershipId })),
          skipDuplicates: true,
        });
      }
      const tenant = await tx.tenant.update({
        where: { id: tenantId },
        data: {
          weeklyDigestEnabled: next.enabled,
          weeklyDigestWeekday: next.weekday,
          weeklyDigestHour: next.hour,
        },
        select: SETTINGS_SELECT,
      });
      const after = this.settingsOf(tenant, wanted);
      // DX-363: ajuste de TODA la clínica, sin la sede activa de quien lo cambia.
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: tenantId,
        reason: WEEKLY_DIGEST_SETTINGS_REASON,
        locationId: null,
        before: { ...before },
        after: { ...after },
      });
      if (event) await writeAuditEvent(tx, event);
      return { ok: true, before, after };
    });
  }

  async enabledTenantIds(): Promise<string[]> {
    // `tenants` no tiene RLS: el barrido las recorre sin clínica en contexto.
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null, weeklyDigestEnabled: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  async runExists(tenantId: string, weekStart: string): Promise<boolean> {
    const run = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.weeklyDigestRun.findUnique({
        where: {
          tenantId_weekStart: { tenantId, weekStart: dateColumn(weekStart) },
        },
        select: { id: true },
      }),
    );
    return run !== null;
  }

  clinic(): Promise<DigestClinic | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { name: true, ...SETTINGS_SELECT },
      });
      if (!tenant) return null;
      try {
        const principal = await resolveReferenceLocation(tx, tenantId, null);
        return {
          name: tenant.name,
          enabled: tenant.weeklyDigestEnabled,
          weekday: tenant.weeklyDigestWeekday,
          hour: tenant.weeklyDigestHour,
          principal: {
            id: principal.id,
            timeZone: principal.timeZone,
            locale: principal.locale,
            hourCycle: principal.hourCycle,
          },
        };
      } catch {
        // Sin sede activa o sin zona: no hay semana que calcular (409 en la
        // prueba; el barrido la salta hasta que el ADMIN la configure).
        return null;
      }
    });
  }

  async activeLocations(): Promise<DigestLocation[]> {
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.location.findMany({
        where: { tenantId, deletedAt: null, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, timeZone: true },
      }),
    );
    return rows.flatMap((r) =>
      r.timeZone && isValidTimeZone(r.timeZone)
        ? [{ id: r.id, name: r.name, timeZone: r.timeZone }]
        : [],
    );
  }

  openCashSessions(): Promise<OpenCashSession[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, (tx) =>
      tx.cashSession.findMany({
        where: { tenantId, status: 'OPEN' },
        select: { locationId: true, openedAt: true },
      }),
    );
  }

  async snapshotOf(weekStart: string): Promise<ReceivablesSnapshot | null> {
    const tenantId = this.tenantId();
    const run = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.weeklyDigestRun.findUnique({
        where: {
          tenantId_weekStart: { tenantId, weekStart: dateColumn(weekStart) },
        },
        select: { receivablesSnapshot: true },
      }),
    );
    return run ? readReceivablesSnapshot(run.receivablesSnapshot) : null;
  }

  async runDone(weekStart: string): Promise<boolean> {
    const tenantId = this.tenantId();
    const run = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.weeklyDigestRun.findUnique({
        where: {
          tenantId_weekStart: { tenantId, weekStart: dateColumn(weekStart) },
        },
        select: { id: true },
      }),
    );
    // El envío se crea y se cierra en la misma transacción: si existe, terminó.
    return run !== null;
  }

  private async eligibleIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<{ eligible: DigestAdmin[]; configured: number }> {
    const rows = await tx.weeklyDigestRecipient.findMany({
      where: { tenantId },
      select: { membership: { select: MEMBER_SELECT } },
      orderBy: { membershipId: 'asc' },
    });
    const eligible = rows
      .map((r) => r.membership)
      .filter((m) => isActiveAdmin(m) && m.user.emailVerifiedAt !== null)
      .map(adminOf);
    return { eligible, configured: rows.length };
  }

  eligibleRecipients(): Promise<{
    eligible: DigestAdmin[];
    configured: number;
  }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, (tx) =>
      this.eligibleIn(tx, tenantId),
    );
  }

  sendRun(input: SendRunInput): Promise<SendRunOutcome> {
    const tenantId = this.tenantId();
    const snapshot = JSON.stringify(input.snapshot);
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // D4: un envío por clínica y semana. Si otro trabajo lo está creando,
      // este INSERT espera a su COMMIT y no hace nada; el FOR UPDATE lo
      // serializa y el segundo ve el envío ya cerrado.
      await tx.$executeRaw`
        INSERT INTO "weekly_digest_runs" ("id", "tenantId", "weekStart", "status", "receivablesSnapshot")
        VALUES (${uuidV7()}::uuid, ${tenantId}::uuid, ${input.weekStart}::date, 'SENDING', ${snapshot}::jsonb)
        ON CONFLICT ("tenantId", "weekStart") DO NOTHING`;
      const [run] = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT "id", "status"::text AS "status" FROM "weekly_digest_runs"
         WHERE "tenantId" = ${tenantId}::uuid AND "weekStart" = ${input.weekStart}::date
         FOR UPDATE`;
      if (run.status !== 'SENDING') return { kind: 'ALREADY_DONE' };

      // Revalidación bajo la transacción: quien dejó de ser ADMIN o de estar
      // verificado desde que se preparó el email no lo recibe.
      const { eligible, configured } = await this.eligibleIn(tx, tenantId);
      const allowed = new Set(eligible.map((a) => a.membershipId));
      const delivered: string[] = [];
      for (const d of input.deliveries) {
        if (!allowed.has(d.membershipId)) continue;
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "weekly_digest_deliveries"
            ("id", "tenantId", "runId", "membershipId", "unsubscribeTokenHash", "expiresAt")
          VALUES (${d.id}::uuid, ${tenantId}::uuid, ${run.id}::uuid, ${d.membershipId}::uuid,
                  ${d.tokenHash}, ${d.expiresAt})
          ON CONFLICT ("runId", "membershipId") DO NOTHING
          RETURNING "id"`;
        if (inserted.length === 0) continue;
        const { id: outboxId } = await d.email.insert(tx);
        await tx.weeklyDigestDelivery.update({
          where: { id: d.id },
          data: { emailOutboxId: outboxId },
          select: { id: true },
        });
        delivered.push(d.id);
      }
      const skipped = Math.max(0, configured - delivered.length);
      const status = delivered.length > 0 ? 'SENT' : 'SKIPPED';
      await tx.$executeRaw`
        UPDATE "weekly_digest_runs"
           SET "status" = ${status}::"WeeklyDigestRunStatus",
               "recipientCount" = ${delivered.length},
               "skippedCount" = ${skipped},
               "completedAt" = timezone('UTC'::text, now())
         WHERE "id" = ${run.id}::uuid`;
      return status === 'SENT'
        ? {
            kind: 'SENT',
            runId: run.id,
            sent: delivered.length,
            skipped,
            deliveryIds: delivered,
          }
        : { kind: 'SKIPPED', runId: run.id, skipped };
    });
  }

  async testCooldownRemaining(
    userId: string,
    cooldownSeconds: number,
    now: Date,
  ): Promise<number> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, (tx) =>
      this.cooldownIn(tx, tenantId, userId, cooldownSeconds, now),
    );
  }

  private async cooldownIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    cooldownSeconds: number,
    now: Date,
  ): Promise<number> {
    const since = new Date(now.getTime() - cooldownSeconds * 1000);
    // audit_events_tenant_actor (tenantId, actorUserId, occurredAt): la
    // última prueba de esta persona en la ventana.
    const [row] = await tx.$queryRaw<{ last: Date | null }[]>`
      SELECT max("occurredAt") AS "last" FROM "audit_events"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "actorUserId" = ${userId}::uuid
         AND "occurredAt" > ${since}
         AND "resourceType" = 'CLINIC_SETTINGS'
         AND "action" = 'VIEW'
         AND "metadata" ->> 'reason' = ${WEEKLY_DIGEST_TEST_SENT_REASON}`;
    if (!row?.last) return 0;
    const elapsed = (now.getTime() - row.last.getTime()) / 1000;
    return Math.max(1, Math.ceil(cooldownSeconds - elapsed));
  }

  recordTestSend(
    email: PreparedEmail,
    ctx: AuditRequestContext,
    cooldownSeconds: number,
    now: Date,
  ): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // Una prueba a la vez por persona: dos clics seguidos no envían dos.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`weekly-digest-test:${tenantId}:${ctx.actor.userId}`}, 0))`;
      const wait = await this.cooldownIn(
        tx,
        tenantId,
        ctx.actor.userId,
        cooldownSeconds,
        now,
      );
      if (wait > 0) return { ok: false, retryAfterSeconds: wait };
      await email.insert(tx);
      await writeAuditEvent(tx, {
        tenantId,
        locationId: null,
        actor: {
          kind: 'user',
          userId: ctx.actor.userId,
          role: ctx.actor.role,
        },
        action: 'VIEW',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: tenantId,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { reason: WEEKLY_DIGEST_TEST_SENT_REASON },
      });
      return { ok: true };
    });
  }

  async clinicName(): Promise<string | null> {
    // `tenants` no tiene RLS: se lee por el id ya resuelto desde el host.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: this.tenantId(), deletedAt: null },
      select: { name: true },
    });
    return tenant?.name ?? null;
  }

  findUnsubscribeLink(
    tokenHash: string,
    at: Date,
  ): Promise<DigestUnsubscribeLink | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // RLS: el enlace de otra clínica no aparece (→ el mismo 404).
      const delivery = await tx.weeklyDigestDelivery.findFirst({
        where: {
          tenantId,
          unsubscribeTokenHash: tokenHash,
          expiresAt: { gt: at },
        },
        select: {
          id: true,
          membership: {
            select: {
              id: true,
              role: true,
              userId: true,
              deletedAt: true,
              user: { select: { deletedAt: true } },
              weeklyDigestRecipient: { select: { membershipId: true } },
            },
          },
        },
      });
      if (!delivery) return null;
      return {
        deliveryId: delivery.id,
        membershipId: delivery.membership.id,
        userId: delivery.membership.userId,
        role: delivery.membership.role,
        // Revisión DX-568, n.º 6: solo lo sigue recibiendo si la fila existe
        // Y la membresía sigue siendo ADMIN activa (si no, no le llega).
        subscribed:
          delivery.membership.weeklyDigestRecipient !== null &&
          delivery.membership.role === ClinicRole.ADMIN &&
          delivery.membership.deletedAt === null &&
          delivery.membership.user.deletedAt === null,
      };
    });
  }

  unsubscribe(
    deliveryId: string,
    at: Date,
    meta: AuditRequestMeta,
  ): Promise<{ removed: boolean } | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // Revalidación bajo bloqueo: un enlace caducado entre la lectura y el
      // POST ya no da de baja a nadie.
      const [delivery] = await tx.$queryRaw<
        { id: string; membershipId: string; usedAt: Date | null }[]
      >`
        SELECT "id", "membershipId", "usedAt" FROM "weekly_digest_deliveries"
         WHERE "id" = ${deliveryId}::uuid AND "tenantId" = ${tenantId}::uuid
           AND "expiresAt" > ${at}
         FOR UPDATE`;
      if (!delivery) return null;
      const membership = await tx.clinicMembership.findFirstOrThrow({
        where: { id: delivery.membershipId, tenantId },
        select: { userId: true, role: true },
      });
      // eslint-disable-next-line no-restricted-syntax -- DX-568: configuración sin datos de pacientes (HARD_DELETE_ALLOWLIST), auditada en la transacción.
      const { count } = await tx.weeklyDigestRecipient.deleteMany({
        where: { tenantId, membershipId: delivery.membershipId },
      });
      if (delivery.usedAt === null) {
        await tx.weeklyDigestDelivery.update({
          where: { id: delivery.id },
          data: { usedAt: at },
          select: { id: true },
        });
      }
      if (count > 0) {
        // El actor es la persona del enlace (el destinatario), sin sesión:
        // origen LINK. Solo cuando de verdad salió de la lista.
        await writeAuditEvent(tx, {
          tenantId,
          locationId: null,
          actor: {
            kind: 'user',
            userId: membership.userId,
            role: membership.role,
          },
          action: 'UPDATE',
          resourceType: 'CLINIC_SETTINGS',
          resourceId: tenantId,
          patient: null,
          requestId: meta.requestId,
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: {
            reason: WEEKLY_DIGEST_UNSUBSCRIBED_REASON,
            origin: 'LINK',
            changedFields: ['recipientMembershipIds'],
          },
        });
      }
      return { removed: count > 0 };
    });
  }
}
