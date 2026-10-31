import { Injectable } from '@nestjs/common';
import { EmailOutboxStatus, EmailTemplate, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../../shared/prisma/prisma.service';
import { EmailTemplateName } from '../../domain/email-message';
import {
  ClaimedOutboxEmail,
  EmailOutboxRepository,
  NewOutboxEmail,
  NewPlatformOutboxEmail,
  OutboxSettlement,
  PlatformRecipientQuota,
} from '../../domain/ports/email-outbox-repository.port';

const TEMPLATE_TO_DB: Record<EmailTemplateName, EmailTemplate> = {
  invitation: EmailTemplate.INVITATION,
  'password-reset': EmailTemplate.PASSWORD_RESET,
  'email-verify': EmailTemplate.EMAIL_VERIFY,
  'appointment-reminder': EmailTemplate.APPOINTMENT_REMINDER,
  'registration-notice': EmailTemplate.REGISTRATION_NOTICE,
  'payment-receipt': EmailTemplate.PAYMENT_RECEIPT,
  'post-op-instructions': EmailTemplate.POST_OP_INSTRUCTIONS,
  'signature-request': EmailTemplate.SIGNATURE_REQUEST,
  'signature-code': EmailTemplate.SIGNATURE_CODE,
};

/**
 * Hora UTC de la BD (como en PrismaJobRepository). DX-355: "nextAttemptAt" lo
 * compara email_outbox_claim con este reloj, así que solo él lo escribe. Ni
 * `new Date()` ni el `@default(now())` de Prisma, que también lo rellena el
 * cliente con el reloj del host: un host unos ms por delante dejaba la fila
 * «en el futuro» y el kick tras encolar no la encontraba.
 */
const NOW = Prisma.sql`timezone('utc', now())`;

/**
 * Persistencia del registro de envíos. Desde una petición (encolar, cancelar
 * pendientes) se escribe con `runWithTenant`, bajo la RLS de la clínica. El
 * despachador, que trabaja para todas las clínicas a la vez, pasa por las
 * funciones SECURITY DEFINER de la migración 20261017120000_email_outbox
 * (reclamar, cerrar). Los emails de plataforma (sin clínica) se insertan por
 * la de DX-144 (20261017231200_dx144_platform_email_quota), que comprueba el
 * tope por destinatario y escribe en la misma operación.
 */
@Injectable()
export class PrismaEmailOutboxRepository implements EmailOutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertPlatform(
    row: NewPlatformOutboxEmail,
    quota: PlatformRecipientQuota,
  ): Promise<{ id: string } | null> {
    const [created] = await this.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT email_outbox_enqueue_platform_capped(
        ${row.template}::"EmailTemplate", ${row.toHash},
        ${row.toMasked}, ${row.payload}, ${row.referenceId}::uuid,
        ${quota.recipientCooldownSeconds}::int, ${quota.recipientDaily}::int
      ) AS id`;
    return created.id ? { id: created.id } : null;
  }

  async platformRecipientAllowed(
    toHash: string,
    quota: PlatformRecipientQuota,
  ): Promise<boolean> {
    const [result] = await this.prisma.$queryRaw<{ allowed: boolean }[]>`
      SELECT email_outbox_platform_allowed(
        ${toHash}, ${quota.recipientCooldownSeconds}::int,
        ${quota.recipientDaily}::int
      ) AS allowed`;
    return result.allowed;
  }

  async insert(row: NewOutboxEmail): Promise<{ id: string }> {
    const tenantId = row.tenantId;
    // SQL crudo para que las horas las ponga la BD (ver NOW); sigue bajo la
    // RLS de la clínica, como el `create` de Prisma.
    const [created] = await this.prisma.runWithTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "email_outbox"
          ("id", "tenantId", "template", "toHash", "toMasked", "referenceId",
           "payload", "status", "nextAttemptAt", "createdAt", "updatedAt")
        VALUES
          (gen_random_uuid(), ${tenantId}::uuid, ${row.template}::"EmailTemplate",
           ${row.toHash}, ${row.toMasked}, ${row.referenceId}::uuid,
           ${row.payload}, 'PENDING', ${NOW}, ${NOW}, ${NOW})
        RETURNING "id"`,
    );
    return { id: created.id };
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
      outcome.status === 'PENDING'
        ? Prisma.sql`${NOW} + make_interval(secs => ${outcome.retryDelayMs / 1000}::double precision)`
        : Prisma.sql`NULL`;
    const lastError = outcome.status === 'SENT' ? null : outcome.lastError;
    const [result] = await this.prisma.$queryRaw<{ settled: boolean }[]>`
      SELECT email_outbox_settle(
        ${id}::uuid,
        ${attempts}::int,
        ${outcome.status}::"EmailOutboxStatus",
        (${next})::timestamp(3),
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
  ): Promise<{
    tenant: number;
    recipient: number;
    secondsSinceLastToRecipient: number | null;
  }> {
    // Como email_outbox_platform_allowed: ventana y enfriamiento contra NOW,
    // el reloj que puso "createdAt". Índices (tenantId, createdAt DESC) y
    // (tenantId, toHash, createdAt DESC).
    const [sends] = await this.prisma.runWithTenant(
      tenantId,
      (tx) => tx.$queryRaw<
        {
          tenant: number;
          recipient: number;
          secondsSinceLastToRecipient: number | null;
        }[]
      >`
        SELECT
          (SELECT count(*)::int FROM "email_outbox"
            WHERE "tenantId" = ${tenantId}::uuid
              AND "createdAt" >= ${NOW} - interval '24 hours') AS "tenant",
          (SELECT count(*)::int FROM "email_outbox"
            WHERE "tenantId" = ${tenantId}::uuid AND "toHash" = ${toHash}
              AND "createdAt" >= ${NOW} - interval '24 hours') AS "recipient",
          (SELECT extract(epoch FROM ${NOW} - max("createdAt"))::float8
             FROM "email_outbox"
            WHERE "tenantId" = ${tenantId}::uuid AND "toHash" = ${toHash})
            AS "secondsSinceLastToRecipient"`,
    );
    return sends;
  }

  /**
   * El owner de cada función ve todas las filas de email_outbox si salta la
   * RLS (superusuario o BYPASSRLS) o si tiene la política permisiva
   * `USING (true) WITH CHECK (true)` y la función no fija `row_security = off`
   * (que con RLS aplicable falla): es el rol dentalix_email_dispatcher de
   * 20261017175000_dx113_email_outbox_dispatcher_role (DX-113).
   */
  async dispatcherAccess(): Promise<{
    executable: boolean;
    ownerSeesAllRows: boolean;
  }> {
    const rows = await this.prisma.$queryRaw<
      { executable: boolean; seesAll: boolean }[]
    >`
      SELECT bool_and(has_function_privilege(p.oid, 'EXECUTE')) AS executable,
             bool_and(
               r.rolsuper OR r.rolbypassrls OR (
                 NOT ('row_security=off' = ANY (coalesce(p.proconfig, '{}')))
                 AND EXISTS (
                   SELECT 1 FROM pg_policies pol
                    WHERE pol.schemaname = 'public'
                      AND pol.tablename = 'email_outbox'
                      AND pol.permissive = 'PERMISSIVE'
                      AND pol.cmd = 'ALL'
                      AND pol.qual = 'true' AND pol.with_check = 'true'
                      AND r.rolname = ANY (pol.roles)))
             ) AS "seesAll"
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname IN ('email_outbox_claim', 'email_outbox_settle',
                           'email_outbox_enqueue_platform_capped',
                           'email_outbox_platform_allowed',
                           'email_outbox_purge_platform')
      HAVING count(*) = 5`;
    const row = rows[0];
    return {
      executable: row?.executable ?? false,
      ownerSeesAllRows: row?.seesAll ?? false,
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
