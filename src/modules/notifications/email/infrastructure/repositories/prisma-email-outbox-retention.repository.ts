import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../shared/prisma/prisma.service';

const BATCH = 1000;

/**
 * Purga de envíos terminados de `email_outbox` (DX-085), con los permisos que
 * la app YA tiene: clínica a clínica, dentro de `runWithTenant`, así que la
 * política `tenant_isolation` (RLS FORCE) acota cada DELETE a esa clínica. No
 * pasa por las funciones del despachador ni le da privilegios nuevos a nadie.
 *
 * Límite conocido: las filas de PLATAFORMA (`tenantId` NULL: verificación del
 * registro, aviso de registro) no las ve `dentalix_app` por RLS y el rol
 * `dentalix_email_dispatcher` no tiene DELETE, así que esta purga no las toca.
 * Al terminar ya no guardan el mensaje (CHECK: payload NULL en SENT/FAILED),
 * solo `toHash`/`toMasked`.
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
}
