import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreatePaymentPlanRepoInput,
  PaymentPlanRepository,
} from '../../domain/ports/payment-plan-repository.port';
import { PaymentPlanWithInstallments } from '../../domain/entities/payment-plan.entity';
import { Periodicity } from '../../application/schedule/generate-schedule';

type PrismaPaymentPlan = Prisma.PaymentPlanGetPayload<{
  include: { installments: true };
}>;

function mapToEntity(row: PrismaPaymentPlan): PaymentPlanWithInstallments {
  return {
    id: row.id,
    tenantId: row.tenantId,
    treatmentPlanId: row.treatmentPlanId,
    patientId: row.patientId,
    currency: row.currency,
    totalToFinance: row.totalToFinance.toNumber(),
    downPayment: row.downPayment.toNumber(),
    installmentsCount: row.installmentsCount,
    periodicity: row.periodicity,
    startDate: row.startDate,
    status: row.status,
    notes: row.notes,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    installments: [...row.installments]
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({
        id: i.id,
        sequence: i.sequence,
        dueDate: i.dueDate,
        amount: i.amount.toNumber(),
      })),
  };
}

@Injectable()
export class PrismaPaymentPlanRepository implements PaymentPlanRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Same rationale as PrismaPaymentRepository.requireTenantId: INSERT needs
  // the tenant supplied explicitly (RLS only filters SELECT/UPDATE), read
  // from the same request context runWithTenant sets the GUC from.
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(
    input: CreatePaymentPlanRepoInput,
  ): Promise<PaymentPlanWithInstallments> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.paymentPlan.create({
        data: {
          tenantId,
          treatmentPlanId: input.treatmentPlanId,
          patientId: input.patientId,
          currency: input.currency,
          totalToFinance: input.totalToFinance,
          downPayment: input.downPayment,
          installmentsCount: input.installmentsCount,
          periodicity: input.periodicity,
          startDate: input.startDate,
          notes: input.notes,
          createdById: input.createdById,
          installments: {
            create: input.installments.map((i) => ({
              tenantId,
              sequence: i.sequence,
              dueDate: i.dueDate,
              amount: i.amount,
            })),
          },
        },
        include: { installments: true },
      });
    });
    return mapToEntity(row);
  }

  async findActiveByPlan(
    treatmentPlanId: string,
  ): Promise<PaymentPlanWithInstallments | null> {
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.paymentPlan.findFirst({
        where: { treatmentPlanId, status: 'ACTIVE', deletedAt: null },
        include: { installments: true },
      });
    });
    return row ? mapToEntity(row) : null;
  }

  async cancel(id: string): Promise<boolean> {
    // Atomic check-and-set (mirrors PrismaPaymentRepository.softDelete):
    // UPDATE ... WHERE id AND status=ACTIVE AND deletedAt IS NULL, so two
    // concurrent cancels can't both "win".
    return this.prisma.runWithTenant(async (tx) => {
      const result = await tx.paymentPlan.updateMany({
        where: { id, status: 'ACTIVE', deletedAt: null },
        data: { status: 'CANCELLED', deletedAt: new Date() },
      });
      return result.count > 0;
    });
  }
}
