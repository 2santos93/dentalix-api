import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  ClinicalEntrySettings,
  ClinicalEntrySettingsRepository,
} from '../../domain/ports/clinical-entry-settings-repository.port';

/**
 * DX-540: ajustes de las evoluciones en `tenants` (tabla global, sin RLS):
 * siempre por el id de la clínica del contexto, nunca del cliente (mismo
 * criterio que la vigencia de la anamnesis y los ajustes de la receta).
 */
@Injectable()
export class PrismaClinicalEntrySettingsRepository implements ClinicalEntrySettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const id = this.tenantContext.getTenantId();
    if (!id) throw new Error('No tenant in context');
    return id;
  }

  async get(): Promise<ClinicalEntrySettings> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { clinicalEntryLicenseWarning: true },
    });
    return {
      warnMissingProfessionalLicense: tenant.clinicalEntryLicenseWarning,
    };
  }

  async set(
    next: ClinicalEntrySettings,
  ): Promise<{ before: ClinicalEntrySettings; after: ClinicalEntrySettings }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada y escritura en la misma transacción: dos
    // ADMIN a la vez no se pisan el «antes» de la auditoría.
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ warn: boolean }[]>`
        SELECT "clinicalEntryLicenseWarning" AS warn
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.update({
        where: { id },
        data: {
          clinicalEntryLicenseWarning: next.warnMissingProfessionalLicense,
        },
        select: { clinicalEntryLicenseWarning: true },
      });
      return {
        before: { warnMissingProfessionalLicense: locked.warn },
        after: {
          warnMissingProfessionalLicense: tenant.clinicalEntryLicenseWarning,
        },
      };
    });
  }
}
