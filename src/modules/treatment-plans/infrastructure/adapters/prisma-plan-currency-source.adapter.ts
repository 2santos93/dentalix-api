import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  PlanCurrencyContext,
  PlanCurrencySource,
} from '../../domain/ports/plan-currency-source.port';

@Injectable()
export class PrismaPlanCurrencySource implements PlanCurrencySource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async context(): Promise<PlanCurrencyContext> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const locationId = this.tenantContext.getLocationId();
    return this.prisma.runWithTenant(
      async (tx): Promise<PlanCurrencyContext> => {
        if (locationId) {
          const location = await tx.location.findFirst({
            where: {
              id: locationId,
              tenantId,
              deletedAt: null,
              isActive: true,
            },
            select: { currency: true },
          });
          if (!location) {
            throw new BadRequestException(
              'La sede indicada no existe o está inactiva.',
            );
          }
          return { kind: 'location', locationId, currency: location.currency };
        }
        // Solo las sedes que el miembro puede usar (DX-089).
        const allowed = this.tenantContext.getAllowedLocationIds();
        const locations = await tx.location.findMany({
          where: {
            tenantId,
            deletedAt: null,
            isActive: true,
            ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
          },
          select: { currency: true },
        });
        const currencies = new Set<string>();
        let unconfigured = false;
        for (const l of locations) {
          if (l.currency) currencies.add(l.currency);
          else unconfigured = true;
        }
        return { kind: 'clinic', currencies: [...currencies], unconfigured };
      },
    );
  }
}
