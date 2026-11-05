import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PlanCreditReader } from '../../domain/ports/plan-credit-reader.port';

/**
 * DX-253 / DX-182: Σ de los asientos del saldo a favor de un plan en su moneda.
 * La única consulta de este término del saldo: la lee `netCredit` y también el
 * recibo, dentro de la transacción del abono.
 */
export async function netCreditIn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  treatmentPlanId: string,
  currency: string,
): Promise<number> {
  const sum = await tx.patientCreditEntry.aggregate({
    where: { tenantId, treatmentPlanId, currency },
    _sum: { amount: true },
  });
  return sum._sum.amount?.toNumber() ?? 0;
}

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
    return this.prisma.runWithTenant((tx) =>
      netCreditIn(tx, tenantId, treatmentPlanId, currency),
    );
  }
}
