import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { LEAD_ANONYMIZED_NAME } from '../domain/lead-rules';
import type { LeadRetentionRepository } from '../domain/lead-repository.port';

/** Prospectos por lote: cada lote es una transacción corta. */
const BATCH = 500;

/**
 * DX-556 · Retención: los prospectos PERDIDOS con más meses de los que fija la
 * clínica (`tenants.leadLostRetentionMonths`) se anonimizan: el nombre pasa a
 * «Anonimizado», se quitan el teléfono y la próxima acción y se borran sus
 * notas. Quedan el canal, la sede, las fechas y los motivos (sin datos
 * personales): el informe de conversión sigue cuadrando. La hora y los meses
 * los pone la BD.
 */
@Injectable()
export class PrismaLeadRetentionRepository implements LeadRetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async anonymizeExpired(tenantId: string): Promise<number> {
    let total = 0;
    for (;;) {
      const done = await this.prisma.runWithTenant(tenantId, async (tx) => {
        // SKIP LOCKED: un prospecto que alguien edita ahora se deja para la
        // pasada siguiente (el barrido es idempotente).
        const rows = await tx.$queryRaw<{ id: string }[]>`
          WITH due AS (
            SELECT l."id" FROM "leads" l
              JOIN "tenants" t ON t."id" = l."tenantId"
             WHERE l."tenantId" = ${tenantId}::uuid
               AND l."stage" = 'LOST' AND l."anonymizedAt" IS NULL
               AND l."lostAt" < pg_catalog.timezone('UTC', pg_catalog.now())
                                - pg_catalog.make_interval(months => t."leadLostRetentionMonths")
             ORDER BY l."lostAt", l."id"
             LIMIT ${BATCH}
             FOR UPDATE OF l SKIP LOCKED
          )
          UPDATE "leads" l SET
            "fullName" = ${LEAD_ANONYMIZED_NAME},
            "phone" = NULL,
            "phoneE164" = NULL,
            "nextActionAt" = NULL,
            "nextActionNote" = NULL,
            "anonymizedAt" = pg_catalog.timezone('UTC', pg_catalog.now()),
            "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
            FROM due
           WHERE l."id" = due."id"
          RETURNING l."id"`;
        if (rows.length === 0) return 0;
        const ids = rows.map((r) => r.id);
        // El guardián deja borrar las notas de un prospecto ya anonimizado.
        await tx.$executeRaw`
          DELETE FROM "lead_notes"
           WHERE "tenantId" = ${tenantId}::uuid AND "leadId" = ANY(${ids}::uuid[])`;
        for (const id of ids) {
          await writeAuditEvent(tx, {
            tenantId,
            locationId: null,
            actor: { kind: 'system' },
            action: 'UPDATE',
            resourceType: 'LEAD',
            resourceId: id,
            patient: null,
            requestId: null,
            ip: null,
            userAgent: null,
            metadata: { reason: 'LEAD_ANONYMIZED', origin: 'JOB' },
          });
        }
        return ids.length;
      });
      total += done;
      if (done < BATCH) return total;
    }
  }
}

/** Para los tests: el tamaño del lote. */
export const LEAD_RETENTION_BATCH = BATCH;
