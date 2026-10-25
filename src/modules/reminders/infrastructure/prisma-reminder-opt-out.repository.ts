import { ConfigService } from '@nestjs/config';
import { ReminderClock } from '../application/reminder-clock';
import { optOutPositiveInteger } from '../application/opt-out-config';
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
  private readonly ttlDays: number;
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly clock: ReminderClock = new ReminderClock(),
    private readonly config: ConfigService = new ConfigService(),
  ) {
    this.ttlDays = optOutPositiveInteger(
      this.config,
      'REMINDER_OPT_OUT_LINK_TTL_DAYS',
      60,
    );
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async issueLink(patientId: string, tokenHash: string): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.prisma.runWithTenant(async (tx) => {
      // Mismo orden de bloqueo que consumo/reactivación: paciente, después enlace.
      const patient = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patients" WHERE "id" = ${patientId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (!patient.length) throw new Error('Patient not found');
      const createdAt = this.clock.now();
      await tx.reminderOptOutLink.create({
        data: {
          tenantId,
          patientId,
          tokenHash,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + this.ttlDays * 86400000),
        },
        select: { id: true },
      });
    });
  }

  findLinkByTokenHash(
    tokenHash: string,
    at: Date,
  ): Promise<OptOutLinkLookup | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS: el enlace de otra clínica no aparece. Un paciente retirado
      // tampoco: ya no recibe nada y su ficha no es de nadie a quien mostrar.
      const link = await tx.reminderOptOutLink.findUnique({
        where: { tokenHash, usedAt: null, expiresAt: { gt: at } },
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
  ): Promise<boolean | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patients" WHERE "id" = ${patientId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (!patient.length) return null;
      if (input.linkId) {
        const { count } = await tx.reminderOptOutLink.updateMany({
          where: {
            id: input.linkId,
            patientId,
            usedAt: null,
            expiresAt: { gt: this.clock.now() },
          },
          data: { usedAt: input.at },
        });
        // Revalidación bajo bloqueo: una lectura anterior a reactivar no autoriza nada.
        if (!count) return null;
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

  async recordMatchWarnings(
    patientIds: string[],
    matchCount: number,
    maxMatches: number,
  ): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.prisma.runWithTenant(async (tx) => {
      // Lotes acotados, una única TX: un fallo no deja avisos parciales.
      for (let offset = 0; offset < patientIds.length; offset += 500) {
        await tx.reminderOptOutMatchWarning.createMany({
          data: patientIds.slice(offset, offset + 500).map((patientId) => ({
            tenantId,
            patientId,
            matchCount,
            maxMatches,
          })),
        });
      }
    });
  }

  async maintenanceTenantIds(): Promise<string[]> {
    // tenants no tiene RLS. Retirar una clínica no cambia su retención.
    const rows = await this.prisma.tenant.findMany({ select: { id: true } });
    return rows.map((row) => row.id);
  }

  purgeLinks(before: Date): Promise<number> {
    return this.prisma.runWithTenant(async (tx) => {
      // Housekeeping TTL: SQL bajo FORCE RLS, sin acceso global a enlaces.
      return tx.$executeRaw`DELETE FROM "reminder_opt_out_links"
        WHERE "expiresAt" < ${before} OR "usedAt" < ${before}`;
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
