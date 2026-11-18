import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { CatalogPatientLanguagesReader } from '../domain/ports/catalog-patient-languages-reader.port';

@Injectable()
export class PrismaCatalogPatientLanguagesReader implements CatalogPatientLanguagesReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(): Promise<string[]> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    // `tenants` es global (sin RLS): por el id del contexto.
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { patientLanguages: true },
    });
    return tenant.patientLanguages;
  }
}
