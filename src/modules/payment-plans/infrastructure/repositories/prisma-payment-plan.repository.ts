import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TreatmentPlanStatus } from '@prisma/client';
import {
  isPlanBillable,
  notBillableMessage,
} from '../../../treatment-plans/domain/plan-status-machine';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreatePaymentPlanRepoInput,
  PaymentPlanRepository,
} from '../../domain/ports/payment-plan-repository.port';
import { PaymentPlanWithInstallments } from '../../domain/entities/payment-plan.entity';

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
      // DX-109 (BE-013): el plan se relee bloqueado (FOR SHARE) en la
      // transacción del alta: ni retirado ni rechazado/cancelado mientras
      // tanto. Cancelarlo (FOR UPDATE) espera a este COMMIT y cancela también
      // el plan de cuotas recién creado.
      const [plan] = await tx.$queryRaw<{ status: TreatmentPlanStatus }[]>`
        SELECT "status" FROM "treatment_plans"
         WHERE "id" = ${input.treatmentPlanId}::uuid
           AND "patientId" = ${input.patientId}::uuid
           AND "deletedAt" IS NULL
         FOR SHARE`;
      if (!plan) {
        throw new NotFoundException('Plan de tratamiento no encontrado');
      }
      if (!isPlanBillable(plan.status)) {
        throw new ConflictException(notBillableMessage(plan.status));
      }
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
          // Sin `tenantId` en las cuotas: con la FK compuesta
          // (tenantId, paymentPlanId) -> payment_plans(tenantId, id), el
          // tenantId de la cuota ES parte de la relación y Prisma lo hereda
          // del plan en el create anidado (pasarlo explícito es un error de
          // validación en runtime).
          installments: {
            create: input.installments.map((i) => ({
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
