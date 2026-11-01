import type { PrismaClient } from '@prisma/client';
import { writePlatformAuditEvent } from '../../audit/infrastructure/platform-audit-event.writer';
import {
  MAX_RETENTION_YEARS,
  PLATFORM_FLOOR_YEARS,
} from '../domain/retention/clinical-retention-config';

export interface RaiseClinicalRetentionFloorInput {
  /** Mínimo de plataforma en años (`loadClinicalRetentionConfig`). */
  minYears: number;
  /** Administrador de plataforma que lo ejecuta; obligatorio salvo en dry-run. */
  actorEmail: string | null;
  dryRun: boolean;
}

/**
 * DX-330: sube a `minYears` el plazo de conservación de cada clínica que está
 * por debajo y deja un evento de plataforma por clínica (`{ before, after }`).
 * Corre con la conexión del OWNER (DIRECT_URL). Una transacción por clínica,
 * con la fila bloqueada: si la clínica cambia su plazo a la vez, gana el valor
 * ya guardado y no se pisa. Solo toca `clinicalRecordRetentionYears`: la
 * ventana de corrección de la clínica queda como estaba. Devuelve los ids de
 * las clínicas que subió (o que subiría, en dry-run), nunca otros datos.
 */
export async function raiseClinicalRetentionFloor(
  prisma: PrismaClient,
  input: RaiseClinicalRetentionFloorInput,
): Promise<{ tenantIds: string[] }> {
  const { minYears, actorEmail, dryRun } = input;
  if (
    !Number.isInteger(minYears) ||
    minYears < PLATFORM_FLOOR_YEARS ||
    minYears > MAX_RETENTION_YEARS
  ) {
    throw new Error(
      `El mínimo debe ser un entero entre ${PLATFORM_FLOOR_YEARS} y ${MAX_RETENTION_YEARS}.`,
    );
  }
  let actorUserId: string | null = null;
  if (actorEmail !== null || !dryRun) {
    if (!actorEmail) throw new Error('Falta --actor-email=<correo>.');
    const actor = await prisma.user.findUnique({
      where: { email: actorEmail },
      select: { id: true, isPlatformAdmin: true },
    });
    if (!actor?.isPlatformAdmin) {
      throw new Error('El actor no es administrador de plataforma.');
    }
    actorUserId = actor.id;
  }

  const candidates = await prisma.tenant.findMany({
    where: { clinicalRecordRetentionYears: { lt: minYears } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (dryRun) return { tenantIds: candidates.map((t) => t.id) };

  const tenantIds: string[] = [];
  for (const { id } of candidates) {
    const raised = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ before: number }[]>`
        SELECT "clinicalRecordRetentionYears" AS before
        FROM tenants
        WHERE id = ${id}::uuid AND "clinicalRecordRetentionYears" < ${minYears}
        FOR UPDATE`;
      if (rows.length === 0) return false;
      await tx.tenant.update({
        where: { id },
        data: { clinicalRecordRetentionYears: minYears },
        select: { id: true },
      });
      await writePlatformAuditEvent(tx, {
        actor: {
          userId: actorUserId as string,
          requestId: null,
          ip: null,
          userAgent: null,
        },
        action: 'CLINICAL_RETENTION_MINIMUM_APPLIED',
        resourceType: 'TENANT',
        resourceId: id,
        metadata: { before: rows[0].before, after: minYears },
      });
      return true;
    });
    if (raised) tenantIds.push(id);
  }
  return { tenantIds };
}
