import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PlanCreditReader } from '../../domain/ports/plan-credit-reader.port';

/** Lee `patient_credit_entries` (DX-253) bajo la RLS de la clínica. */
@Injectable()
export class PrismaPlanCreditReader implements PlanCreditReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async netCredit(treatmentPlanId: string, currency: string): Promise<number> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const sum = await this.prisma.runWithTenant((tx) =>
      tx.patientCreditEntry.aggregate({
        where: { tenantId, treatmentPlanId, currency },
        _sum: { amount: true },
      }),
    );
    return sum._sum.amount?.toNumber() ?? 0;
  }
}
