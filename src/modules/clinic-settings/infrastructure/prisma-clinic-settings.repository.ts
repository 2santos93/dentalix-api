import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  clinicProfileForAudit,
  type ClinicProfile,
  type ClinicProfilePatch,
} from '../domain/clinic-settings';
import type {
  ClinicSettingsRepository,
  StoredClinicSettings,
} from '../domain/ports/clinic-settings-repository.port';

const SELECT = {
  name: true,
  legalName: true,
  taxId: true,
  taxIdLabel: true,
  fiscalAddress: true,
  contactEmail: true,
  contactPhone: true,
  primaryColor: true,
  logoUrl: true,
  logoKey: true,
} satisfies Prisma.TenantSelect;

type Row = Prisma.TenantGetPayload<{ select: typeof SELECT }>;

function toStored(row: Row): StoredClinicSettings {
  const profile: ClinicProfile = {
    name: row.name,
    legalName: row.legalName,
    taxId: row.taxId,
    taxIdLabel: row.taxIdLabel,
    fiscalAddress: row.fiscalAddress,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    primaryColor: row.primaryColor,
  };
  return { profile, logoUrl: row.logoUrl, logoKey: row.logoKey };
}

/**
 * DX-019. `tenants` es global (sin RLS): siempre por el id del contexto, nunca
 * por uno que llegue en la petición. La fila se bloquea (FOR UPDATE) para que
 * dos cambios simultáneos se ordenen y cada uno audite su antes real.
 */
@Injectable()
export class PrismaClinicSettingsRepository implements ClinicSettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async get(): Promise<StoredClinicSettings> {
    const row = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: SELECT,
    });
    return toStored(row);
  }

  updateProfile(
    patch: ClinicProfilePatch,
    ctx: AuditRequestContext,
  ): Promise<StoredClinicSettings> {
    const id = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = toStored(
        await tx.tenant.findUniqueOrThrow({ where: { id }, select: SELECT }),
      );
      const after = toStored(
        await tx.tenant.update({ where: { id }, data: patch, select: SELECT }),
      );
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: id,
        reason: 'CLINIC_PROFILE',
        before: clinicProfileForAudit(before.profile),
        after: clinicProfileForAudit(after.profile),
      });
      if (event) await writeAuditEvent(tx, event);
      return after;
    });
  }

  setLogo(
    logo: { key: string; url: string } | null,
    ctx: AuditRequestContext,
  ): Promise<StoredClinicSettings> {
    const id = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = toStored(
        await tx.tenant.findUniqueOrThrow({ where: { id }, select: SELECT }),
      );
      const after = toStored(
        await tx.tenant.update({
          where: { id },
          data: { logoKey: logo?.key ?? null, logoUrl: logo?.url ?? null },
          select: SELECT,
        }),
      );
      // En la auditoría va la clave (o la URL anterior a DX-019), nunca bytes.
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: id,
        reason: 'CLINIC_LOGO',
        before: { logo: before.logoKey ?? before.logoUrl },
        after: { logo: after.logoKey ?? after.logoUrl },
      });
      if (event) await writeAuditEvent(tx, event);
      return after;
    });
  }
}
