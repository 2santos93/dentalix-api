import { Injectable } from '@nestjs/common';
import { Prisma, type ReminderOptOutSource } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type {
  MobileCandidate,
  OptOutClinicBranding,
  OptOutLinkLookup,
  ReminderOptOutRepository,
} from '../domain/ports/reminder-opt-out-repository.port';

/**
 * Pacientes vivos de la clínica activa con esos 8 últimos dígitos de móvil.
 * Compara la columna "phoneTail" (la mantiene un trigger) con `=`, que bajo
 * RLS FORCE sí es condición del índice parcial patients_tenant_phone_tail_idx
 * (DX-225); la expresión dx_phone_tail(phone) quedaba en Filter. La API
 * compara después el E.164 completo. Exportada para que el int-spec explique
 * (EXPLAIN) la consulta real.
 */
export function patientsByPhoneTailSql(tail: string): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" AS "patientId", "phone"
      FROM "patients"
     WHERE "tenantId" = current_setting('app.current_tenant', true)::uuid
       AND "phoneTail" = ${tail}
       AND "deletedAt" IS NULL
     ORDER BY "createdAt", "id"`;
}

@Injectable()
export class PrismaReminderOptOutRepository implements ReminderOptOutRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async issueLink(patientId: string, tokenHash: string): Promise<void> {
    const tenantId = this.requireTenantId();
    // La FK compuesta exige que el paciente sea de esta clínica.
    await this.prisma.runWithTenant((tx) =>
      tx.reminderOptOutLink.create({
        data: { tenantId, patientId, tokenHash },
        select: { id: true },
      }),
    );
  }

  findLinkByTokenHash(tokenHash: string): Promise<OptOutLinkLookup | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS: el enlace de otra clínica no aparece. Un paciente retirado
      // tampoco: ya no recibe nada y su ficha no es de nadie a quien mostrar.
      const link = await tx.reminderOptOutLink.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          patient: {
            select: {
              id: true,
              firstName: true,
              reminderOptOutAt: true,
              deletedAt: true,
            },
          },
        },
      });
      if (!link || link.patient.deletedAt) return null;
      return {
        linkId: link.id,
        patientId: link.patient.id,
        patientFirstName: link.patient.firstName,
        optedOutAt: link.patient.reminderOptOutAt,
      };
    });
  }

  optOut(
    patientId: string,
    input: { source: ReminderOptOutSource; at: Date; linkId?: string },
  ): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      if (input.linkId) {
        await tx.reminderOptOutLink.updateMany({
          where: { id: input.linkId, usedAt: null },
          data: { usedAt: input.at },
        });
      }
      // UPDATE condicional: dos clics (o el enlace y un «BAJA») a la vez no
      // registran dos bajas; el segundo espera al COMMIT y ya no encaja.
      const { count } = await tx.patient.updateMany({
        where: { id: patientId, deletedAt: null, reminderOptOutAt: null },
        data: {
          reminderOptOutAt: input.at,
          reminderOptOutSource: input.source,
        },
      });
      return count > 0;
    });
  }

  findByPhoneTail(tail: string): Promise<MobileCandidate[]> {
    return this.prisma.runWithTenant((tx) =>
      tx.$queryRaw<MobileCandidate[]>(patientsByPhoneTailSql(tail)),
    );
  }

  async principalLocationCountry(): Promise<string | null> {
    const location = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { country: true },
      }),
    );
    return location?.country ?? null;
  }

  clinicBranding(): Promise<OptOutClinicBranding | null> {
    // `tenants` no tiene RLS: se lee por el id ya resuelto desde el host.
    const tenantId = this.requireTenantId();
    return this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { name: true, primaryColor: true, logoUrl: true },
    });
  }
}
