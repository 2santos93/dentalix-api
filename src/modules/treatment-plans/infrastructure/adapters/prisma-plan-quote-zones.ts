import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { loadLocationZones } from '../../../../shared/locations/location-time-zone';
import type { PlanQuoteZones } from '../../domain/ports/plan-quote-zones.port';

/**
 * DX-379: zonas de las sedes de presentación y de la sede de escritura, en
 * UNA consulta y bajo la RLS de la clínica. Tolerante: una sede sin zona
 * válida da `null` (no 409), para no tumbar listas y fichas por ella.
 */
@Injectable()
export class PrismaPlanQuoteZones implements PlanQuoteZones {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  zonesFor(
    locationIds: readonly string[],
  ): Promise<(locationId: string | null) => string | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant(
      async (tx) => {
        const writeLocationId = await this.tenantContext.writeLocationId(tx);
        const zones = await loadLocationZones(tx, tenantId, [
          ...locationIds,
          writeLocationId,
        ]);
        return (locationId: string | null) =>
          zones.configured.get(locationId ?? writeLocationId) ?? null;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
