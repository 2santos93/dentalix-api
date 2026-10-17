import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../shared/prisma/prisma.service';

const BATCH = 1000;

/**
 * Purga de envíos terminados de `email_outbox` (DX-085), con los permisos que
 * la app YA tiene: clínica a clínica, dentro de `runWithTenant`, así que la
 * política `tenant_isolation` (RLS FORCE) acota cada DELETE a esa clínica. No
 * da privilegios nuevos a `dentalix_app`.
 *
 * Las filas de PLATAFORMA (`tenantId` NULL: verificación y aviso del
 * registro) no las ve `dentalix_app` por RLS: las borra la función
 * `email_outbox_purge_platform` del rol `dentalix_email_dispatcher` (DX-144,
 * SEC-037), cuyo DELETE acota además una política RESTRICTIVA a
 * `tenantId IS NULL`. La función nunca borra nada de los últimos 7 días (el
 * tope por destinatario mira 24 h).
 */
@Injectable()
export class PrismaEmailOutboxRetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({ select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** SENT y FAILED creados antes de `before` en esa clínica. */
  async purgeFinished(tenantId: string, before: Date): Promise<number> {
    let total = 0;
    for (;;) {
      // Borrado duro legítimo (registro técnico con retención), por tandas.
      const n = await this.prisma.runWithTenant(
        tenantId,
        (tx) => tx.$executeRaw`
          DELETE FROM "email_outbox"
           WHERE "id" IN (
             SELECT "id" FROM "email_outbox"
              WHERE "tenantId" = ${tenantId}::uuid
                AND "status" IN ('SENT', 'FAILED')
                AND "createdAt" < (${before.toISOString()}::timestamptz AT TIME ZONE 'UTC')
              LIMIT ${BATCH}
           )`,
      );
      total += n;
      if (n < BATCH) return total;
    }
  }

  /** SENT y FAILED de plataforma creados antes de `before`, por tandas. */
  async purgePlatformFinished(before: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const [{ n }] = await this.prisma.$queryRaw<{ n: number }[]>`
        SELECT email_outbox_purge_platform(
          (${before.toISOString()}::timestamptz AT TIME ZONE 'UTC')::timestamp(3),
          ${BATCH}::int
        ) AS n`;
      total += n;
      if (n < BATCH) return total;
    }
  }
}
