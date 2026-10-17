import { Injectable } from '@nestjs/common';
import { ClinicRole, type DiscountPolicy } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { DiscountPolicyRules } from '../domain/discount-policy';
import type {
  DiscountPolicyRepository,
  StoredDiscountPolicy,
} from '../domain/ports/discount-policy-repository.port';

function toEntity(row: DiscountPolicy): StoredDiscountPolicy {
  return {
    maxPercentByRole: {
      [ClinicRole.ADMIN]: row.adminMaxPercent,
      [ClinicRole.DENTIST]: row.dentistMaxPercent,
      [ClinicRole.ASSISTANT]: row.assistantMaxPercent,
      [ClinicRole.RECEPTION]: row.receptionMaxPercent,
    },
    reasonRequiredAbovePercent: row.reasonRequiredAbovePercent,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
  };
}

/** Una fila por clínica (PK = tenantId), con RLS FORCE por tenant. */
@Injectable()
export class PrismaDiscountPolicyRepository implements DiscountPolicyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async find(): Promise<StoredDiscountPolicy | null> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.discountPolicy.findUnique({ where: { tenantId } }),
    );
    return row ? toEntity(row) : null;
  }

  async save(
    rules: DiscountPolicyRules,
    updatedById: string,
  ): Promise<StoredDiscountPolicy> {
    const tenantId = this.requireTenantId();
    const data = {
      adminMaxPercent: rules.maxPercentByRole.ADMIN,
      dentistMaxPercent: rules.maxPercentByRole.DENTIST,
      assistantMaxPercent: rules.maxPercentByRole.ASSISTANT,
      receptionMaxPercent: rules.maxPercentByRole.RECEPTION,
      reasonRequiredAbovePercent: rules.reasonRequiredAbovePercent,
      updatedById,
    };
    const row = await this.prisma.runWithTenant((tx) =>
      tx.discountPolicy.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: data,
      }),
    );
    return toEntity(row);
  }
}
