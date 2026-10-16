import { Injectable } from '@nestjs/common';
import { EmailOutboxStatus, EmailTemplate } from '@prisma/client';
import { PrismaService } from '../../../../../shared/prisma/prisma.service';
import { EmailTemplateName } from '../../domain/email-message';
import {
  ClaimedOutboxEmail,
  EmailOutboxRepository,
  NewOutboxEmail,
  OutboxSettlement,
} from '../../domain/ports/email-outbox-repository.port';

const TEMPLATE_TO_DB: Record<EmailTemplateName, EmailTemplate> = {
  invitation: EmailTemplate.INVITATION,
  'password-reset': EmailTemplate.PASSWORD_RESET,
  'email-verify': EmailTemplate.EMAIL_VERIFY,
  'appointment-reminder': EmailTemplate.APPOINTMENT_REMINDER,
  'registration-notice': EmailTemplate.REGISTRATION_NOTICE,
};

/**
 * Persistencia del registro de envíos. Desde una petición (encolar, cancelar
 * pendientes) se escribe con `runWithTenant`, bajo la RLS de la clínica. El
 * despachador, que trabaja para todas las clínicas a la vez, pasa por las
 * funciones SECURITY DEFINER de la migración 20261017120000_email_outbox
 * (reclamar, cerrar) y los emails de plataforma (sin clínica) se insertan por
 * la suya.
 */
@Injectable()
export class PrismaEmailOutboxRepository implements EmailOutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(row: NewOutboxEmail): Promise<{ id: string }> {
    if (row.tenantId === null) {
      const [created] = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT email_outbox_enqueue_platform(
          ${row.template}::"EmailTemplate", ${row.toHash}, ${row.toMasked},
          ${row.payload}, ${row.referenceId}::uuid
        ) AS id`;
      return { id: created.id };
    }
    const tenantId = row.tenantId;
    return this.prisma.runWithTenant(tenantId, (tx) =>
      tx.emailOutbox.create({
        data: {
          tenantId,
          template: TEMPLATE_TO_DB[row.template],
          toHash: row.toHash,
          toMasked: row.toMasked,
          referenceId: row.referenceId,
          // Copia a un Uint8Array sobre ArrayBuffer propio (lo que tipa Prisma).
          payload: new Uint8Array(row.payload),
          status: EmailOutboxStatus.PENDING,
          nextAttemptAt: new Date(),
        },
        select: { id: true },
      }),
    );
  }

  async claimDue(
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedOutboxEmail[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        tenantId: string | null;
        payload: Uint8Array | null;
        attempts: number;
      }[]
    >`SELECT * FROM email_outbox_claim(${limit}::int, ${leaseSeconds}::int)`;
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      payload: row.payload ? Buffer.from(row.payload) : null,
      attempts: row.attempts,
    }));
  }

  async settle(
    id: string,
    attempts: number,
    outcome: OutboxSettlement,
  ): Promise<boolean> {
    const next =
      outcome.status === 'PENDING' ? outcome.nextAttemptAt.toISOString() : null;
    const lastError = outcome.status === 'SENT' ? null : outcome.lastError;
    const [result] = await this.prisma.$queryRaw<{ settled: boolean }[]>`
      SELECT email_outbox_settle(
        ${id}::uuid,
        ${attempts}::int,
        ${outcome.status}::"EmailOutboxStatus",
        (${next}::timestamptz AT TIME ZONE 'UTC')::timestamp(3),
        ${lastError}
      ) AS settled`;
    return result.settled;
  }

  async supersedePending(
    tenantId: string,
    referenceId: string,
    template: EmailTemplateName,
  ): Promise<number> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const result = await tx.emailOutbox.updateMany({
        where: {
          referenceId,
          template: TEMPLATE_TO_DB[template],
          status: EmailOutboxStatus.PENDING,
        },
        data: {
          status: EmailOutboxStatus.FAILED,
          payload: null,
          lastError: 'Superseded',
        },
      });
      return result.count;
    });
  }

  async recentSends(
    tenantId: string,
    toHash: string,
    since: Date,
  ): Promise<{
    tenant: number;
    recipient: number;
    lastToRecipient: Date | null;
  }> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const [tenant, recipient, last] = await Promise.all([
        tx.emailOutbox.count({ where: { createdAt: { gte: since } } }),
        tx.emailOutbox.count({ where: { toHash, createdAt: { gte: since } } }),
        tx.emailOutbox.findFirst({
          where: { toHash },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);
      return { tenant, recipient, lastToRecipient: last?.createdAt ?? null };
    });
  }

  async dispatcherAccess(): Promise<{
    executable: boolean;
    ownerBypassesRls: boolean;
  }> {
    const rows = await this.prisma.$queryRaw<
      { executable: boolean; bypass: boolean }[]
    >`
      SELECT bool_and(has_function_privilege(p.oid, 'EXECUTE')) AS executable,
             bool_and(r.rolsuper OR r.rolbypassrls) AS bypass
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname IN ('email_outbox_claim', 'email_outbox_settle',
                           'email_outbox_enqueue_platform')
      HAVING count(*) = 3`;
    const row = rows[0];
    return {
      executable: row?.executable ?? false,
      ownerBypassesRls: row?.bypass ?? false,
    };
  }

  async findBrand(tenantId: string): Promise<{
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
  } | null> {
    // `tenants` es global (sin RLS), igual que PrismaTenantBrandingRepository.
    return this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { name: true, logoUrl: true, primaryColor: true },
    });
  }
}
