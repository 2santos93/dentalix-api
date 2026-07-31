import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreatePaymentRepoInput,
  ListPaymentsReceivedInRangeParams,
  PaymentRepository,
} from '../../domain/ports/payment-repository.port';
import { Payment } from '../../domain/entities/payment.entity';

type PrismaPayment = Prisma.PaymentGetPayload<Record<string, never>>;

function mapToEntity(payment: PrismaPayment): Payment {
  return {
    id: payment.id,
    tenantId: payment.tenantId,
    treatmentPlanId: payment.treatmentPlanId,
    patientId: payment.patientId,
    amount: payment.amount.toNumber(),
    currency: payment.currency,
    paidAt: payment.paidAt,
    method: payment.method,
    notes: payment.notes,
    createdById: payment.createdById,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

@Injectable()
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE, which RLS
   * filters transparently — an INSERT still needs the app to supply it
   * explicitly. We never take it from the input (never from the client); we
   * read it from the same request-scoped context that `runWithTenant(fn)`
   * uses to set `app.current_tenant`, so the value written always matches
   * the GUC the WITH CHECK policy validates against (same convention as
   * PrismaSaleRepository / PrismaTreatmentPlanRepository).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(input: CreatePaymentRepoInput): Promise<Payment> {
    const tenantId = this.requireTenantId();
    const payment = await this.prisma.runWithTenant(async (tx) => {
      return tx.payment.create({
        data: {
          tenantId,
          treatmentPlanId: input.treatmentPlanId,
          patientId: input.patientId,
          amount: input.amount,
          currency: input.currency,
          paidAt: input.paidAt,
          method: input.method,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          createdById: input.createdById,
        },
      });
    });
    return mapToEntity(payment);
  }

  async findById(id: string): Promise<Payment | null> {
    const payment = await this.prisma.runWithTenant(async (tx) => {
      return tx.payment.findFirst({ where: { id, deletedAt: null } });
    });
    return payment ? mapToEntity(payment) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    // RLS (runWithTenant) scopes this to the current tenant, matching the
    // (tenantId, idempotencyKey) unique index. NOT filtered by `deletedAt`: a
    // replay must resolve to the SAME row even if it was later voided, so we
    // never insert a duplicate for a key that already exists.
    const payment = await this.prisma.runWithTenant(async (tx) => {
      return tx.payment.findFirst({ where: { idempotencyKey } });
    });
    return payment ? mapToEntity(payment) : null;
  }

  async listByPlan(treatmentPlanId: string): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: { treatmentPlanId, deletedAt: null },
        orderBy: { paidAt: 'desc' },
      });
      return payments.map(mapToEntity);
    });
  }

  async listByPatient(patientId: string): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: { patientId, deletedAt: null },
        orderBy: { paidAt: 'desc' },
      });
      return payments.map(mapToEntity);
    });
  }

  async softDelete(id: string): Promise<boolean> {
    // Single atomic UPDATE ... WHERE id = ? AND deletedAt IS NULL (RLS
    // additionally scopes it to the current tenant) instead of a
    // findFirst-then-update pair -- that sequence let two concurrent voids
    // of the same payment both pass the "not yet voided" check (TOCTOU
    // race), since `update({ where: { id } })` alone never re-checked
    // `deletedAt`. `count` tells the caller, in one round trip, whether
    // THIS call actually voided the row.
    return this.prisma.runWithTenant(async (tx) => {
      const result = await tx.payment.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      return result.count > 0;
    });
  }

  async listReceivedInRange(
    params: ListPaymentsReceivedInRangeParams,
  ): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: {
          deletedAt: null,
          paidAt: { gte: params.from, lt: params.to },
        },
        orderBy: { paidAt: 'desc' },
      });
      return payments.map(mapToEntity);
    });
  }
}
