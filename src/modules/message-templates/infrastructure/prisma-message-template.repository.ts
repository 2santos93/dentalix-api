import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  configAuditEvent,
  type ConfigSnapshot,
} from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { PreparedEmail } from '../../notifications/email/application/email-outbox.service';
import type { MessageText } from '../domain/message-catalog';
import type {
  MessageTemplateId,
  MessageTemplateRepository,
  MessageTestRecipient,
  StoredMessageTemplate,
} from '../domain/ports/message-template-repository.port';

/** Motivos de auditoría de Ajustes › Mensajes (CLINIC_SETTINGS). */
export const MESSAGE_TEMPLATE_UPDATED_REASON = 'MESSAGE_TEMPLATE_UPDATED';
export const MESSAGE_TEMPLATE_RESET_REASON = 'MESSAGE_TEMPLATE_RESET';
export const MESSAGE_TEMPLATE_TEST_SENT_REASON = 'MESSAGE_TEMPLATE_TEST_SENT';

const ROW_SELECT = {
  id: true,
  key: true,
  channel: true,
  language: true,
  subject: true,
  body: true,
  updatedAt: true,
  updatedBy: { select: { fullName: true } },
} as const;

type Row = Prisma.MessageTemplateGetPayload<{ select: typeof ROW_SELECT }>;

function stored(row: Row): StoredMessageTemplate {
  return {
    id: row.id,
    key: row.key,
    channel: row.channel,
    language: row.language,
    subject: row.subject,
    body: row.body,
    updatedAt: row.updatedAt,
    updatedByName: row.updatedBy?.fullName ?? null,
  };
}

/**
 * Lo que la auditoría guarda de un texto: la identidad, el asunto (cabe en
 * los 255 del evento) y del cuerpo su longitud y huella; el cuerpo en sí es
 * un campo oculto (cuenta para saber si cambió, su valor no se guarda).
 */
export function messageTemplateSnapshot(
  id: MessageTemplateId,
  text: MessageText,
): ConfigSnapshot {
  return {
    messageKey: id.key,
    channel: id.channel,
    language: id.language,
    subject: text.subject,
    body: text.body,
    bodyLength: [...text.body].length,
    bodyHash: createHash('sha256').update(text.body).digest('hex'),
  };
}

const HIDDEN = ['body'] as const;

/** H4/H5: qué mensaje, en todos los eventos (también en un UPDATE). */
function templateMeta(id: MessageTemplateId) {
  return { key: id.key, channel: id.channel, language: id.language };
}

@Injectable()
export class PrismaMessageTemplateRepository implements MessageTemplateRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  private where(tenantId: string, id: MessageTemplateId) {
    return {
      tenantId_key_channel_language: {
        tenantId,
        key: id.key,
        channel: id.channel,
        language: id.language,
      },
    };
  }

  list(): Promise<StoredMessageTemplate[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) =>
      (
        await tx.messageTemplate.findMany({
          where: { tenantId },
          select: ROW_SELECT,
          orderBy: [{ key: 'asc' }, { channel: 'asc' }, { language: 'asc' }],
        })
      ).map(stored),
    );
  }

  find(id: MessageTemplateId): Promise<MessageText | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, (tx) =>
      tx.messageTemplate.findUnique({
        where: this.where(tenantId, id),
        select: { subject: true, body: true },
      }),
    );
  }

  async patientLanguages(): Promise<string[]> {
    // `tenants` no tiene RLS: se lee por el id ya resuelto desde el host.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: this.tenantId(), deletedAt: null },
      select: { patientLanguages: true },
    });
    return tenant?.patientLanguages ?? ['es'];
  }

  async clinicName(): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: this.tenantId(), deletedAt: null },
      select: { name: true },
    });
    return tenant?.name ?? null;
  }

  /** Una escritura a la vez por (clínica, clave, canal, idioma): el «antes» no se pisa. */
  private async lock(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: MessageTemplateId,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`message-template:${tenantId}:${id.key}:${id.channel}:${id.language}`}, 0))`;
  }

  save(
    id: MessageTemplateId,
    text: MessageText,
    ctx: AuditRequestContext,
  ): Promise<StoredMessageTemplate> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      await this.lock(tx, tenantId, id);
      const before = await tx.messageTemplate.findUnique({
        where: this.where(tenantId, id),
        select: ROW_SELECT,
      });
      if (
        before &&
        before.subject === text.subject &&
        before.body === text.body
      ) {
        return stored(before);
      }
      const after = before
        ? await tx.messageTemplate.update({
            where: { id: before.id },
            data: {
              subject: text.subject,
              body: text.body,
              updatedById: ctx.actor.userId,
            },
            select: ROW_SELECT,
          })
        : await tx.messageTemplate.create({
            data: {
              id: randomUUID(),
              tenantId,
              key: id.key,
              channel: id.channel,
              language: id.language,
              subject: text.subject,
              body: text.body,
              updatedById: ctx.actor.userId,
            },
            select: ROW_SELECT,
          });
      // DX-363: ajuste de TODA la clínica, sin la sede activa de quien lo cambia.
      const event = before
        ? configAuditEvent(ctx, {
            action: 'UPDATE',
            resourceType: 'CLINIC_SETTINGS',
            resourceId: after.id,
            reason: MESSAGE_TEMPLATE_UPDATED_REASON,
            locationId: null,
            hiddenFields: HIDDEN,
            before: messageTemplateSnapshot(id, before),
            after: messageTemplateSnapshot(id, after),
            extra: { messageTemplate: templateMeta(id) },
          })
        : configAuditEvent(ctx, {
            action: 'CREATE',
            resourceType: 'CLINIC_SETTINGS',
            resourceId: after.id,
            reason: MESSAGE_TEMPLATE_UPDATED_REASON,
            locationId: null,
            hiddenFields: HIDDEN,
            after: messageTemplateSnapshot(id, after),
            extra: { messageTemplate: templateMeta(id) },
          });
      if (event) await writeAuditEvent(tx, event);
      return stored(after);
    });
  }

  reset(id: MessageTemplateId, ctx: AuditRequestContext): Promise<boolean> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      await this.lock(tx, tenantId, id);
      const before = await tx.messageTemplate.findUnique({
        where: this.where(tenantId, id),
        select: ROW_SELECT,
      });
      if (!before) return false;
      // eslint-disable-next-line no-restricted-syntax -- DX-565: configuración sin datos de pacientes (HARD_DELETE_ALLOWLIST), auditada en la transacción.
      await tx.messageTemplate.delete({ where: { id: before.id } });
      await writeAuditEvent(
        tx,
        configAuditEvent(ctx, {
          action: 'DELETE',
          resourceType: 'CLINIC_SETTINGS',
          resourceId: before.id,
          reason: MESSAGE_TEMPLATE_RESET_REASON,
          locationId: null,
          hiddenFields: HIDDEN,
          before: messageTemplateSnapshot(id, before),
          extra: { messageTemplate: templateMeta(id) },
        }),
      );
      return true;
    });
  }

  async testRecipient(userId: string): Promise<MessageTestRecipient | null> {
    // `users` es global (sin RLS): el RolesGuard ya exigió ADMIN de la clínica.
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true, emailVerifiedAt: true },
    });
    return user
      ? { email: user.email, verified: user.emailVerifiedAt !== null }
      : null;
  }

  testCooldownRemaining(
    userId: string,
    cooldownSeconds: number,
  ): Promise<number> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, (tx) =>
      this.cooldownIn(tx, tenantId, userId, cooldownSeconds),
    );
  }

  /**
   * H9: la ventana se cuenta con el reloj de la BD (el mismo que pone
   * `occurredAt`), nunca con el de la API. Por persona Y clínica: un ADMIN
   * de varias clínicas tiene una ventana en cada una (decisión documentada).
   */
  private async cooldownIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    cooldownSeconds: number,
  ): Promise<number> {
    // audit_events_tenant_actor (tenantId, actorUserId, occurredAt): la
    // última prueba de esta persona en la ventana.
    const [row] = await tx.$queryRaw<{ elapsed: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM ((clock_timestamp() AT TIME ZONE 'UTC') - max("occurredAt")))::float8 AS "elapsed"
        FROM "audit_events"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "actorUserId" = ${userId}::uuid
         AND "occurredAt" > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${cooldownSeconds})
         AND "resourceType" = 'CLINIC_SETTINGS'
         AND "action" = 'VIEW'
         AND "metadata" ->> 'reason' = ${MESSAGE_TEMPLATE_TEST_SENT_REASON}`;
    if (row?.elapsed == null) return 0;
    return Math.max(1, Math.ceil(cooldownSeconds - row.elapsed));
  }

  recordTestSend(
    email: PreparedEmail,
    id: MessageTemplateId,
    draft: boolean,
    ctx: AuditRequestContext,
    cooldownSeconds: number,
  ): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // Una prueba a la vez por persona: dos clics seguidos no envían dos.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`message-template-test:${tenantId}:${ctx.actor.userId}`}, 0))`;
      const wait = await this.cooldownIn(
        tx,
        tenantId,
        ctx.actor.userId,
        cooldownSeconds,
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
        metadata: {
          reason: MESSAGE_TEMPLATE_TEST_SENT_REASON,
          messageTemplate: { ...templateMeta(id), draft },
        },
      });
      return { ok: true };
    });
  }
}
