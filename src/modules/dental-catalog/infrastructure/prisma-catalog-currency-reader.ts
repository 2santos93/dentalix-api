import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { clinicCatalogCurrency } from '../../treatment-plans/domain/pricing/catalog-currency';
import type { CatalogCurrencyReader } from '../domain/ports/catalog-currency-reader.port';

@Injectable()
export class PrismaCatalogCurrencyReader implements CatalogCurrencyReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  current(): Promise<string | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant(async (tx) => {
      const active = await tx.location.findMany({
        where: { tenantId, isActive: true, deletedAt: null },
        select: { currency: true },
      });
      // `tenants` es global (sin RLS): por el id del contexto.
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { catalogCurrency: true },
      });
      return clinicCatalogCurrency(tenant.catalogCurrency, active);
    });
  }
}
