import {
  Installment,
  PaymentPlanWithInstallments,
} from '../../../domain/entities/payment-plan.entity';
import {
  CreatePaymentPlanRepoInput,
  PaymentPlanRepository,
} from '../../../domain/ports/payment-plan-repository.port';

type StoredPlan = PaymentPlanWithInstallments & { deletedAt: Date | null };

let seq = 0;
const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Real in-memory fake for `PaymentPlanRepository` — implements ACTUAL
 * filtering (ACTIVE + not soft-deleted, plan scoping) so use-case specs
 * genuinely exercise it. Mirrors PrismaPaymentPlanRepository semantics.
 */
export class InMemoryPaymentPlanRepository implements PaymentPlanRepository {
  private readonly plans: StoredPlan[] = [];

  create(
    input: CreatePaymentPlanRepoInput,
  ): Promise<PaymentPlanWithInstallments> {
    const planId = `pp-${++seq}`;
    const installments: Installment[] = input.installments.map((i) => ({
      id: `inst-${planId}-${i.sequence}`,
      sequence: i.sequence,
      dueDate: i.dueDate,
      amount: i.amount,
    }));
    const row: StoredPlan = {
      id: planId,
      tenantId: 't1',
      treatmentPlanId: input.treatmentPlanId,
      patientId: input.patientId,
      currency: input.currency,
      totalToFinance: input.totalToFinance,
      downPayment: input.downPayment,
      installmentsCount: input.installmentsCount,
      periodicity: input.periodicity,
      startDate: input.startDate,
      status: 'ACTIVE',
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      installments,
    };
    this.plans.push(row);
    return Promise.resolve(this.toEntity(row));
  }

  findActiveByPlan(
    treatmentPlanId: string,
  ): Promise<PaymentPlanWithInstallments | null> {
    const row = this.plans.find(
      (p) =>
        p.treatmentPlanId === treatmentPlanId &&
        p.status === 'ACTIVE' &&
        p.deletedAt === null,
    );
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  cancel(id: string): Promise<boolean> {
    const row = this.plans.find(
      (p) => p.id === id && p.status === 'ACTIVE' && p.deletedAt === null,
    );
    if (!row) {
      return Promise.resolve(false);
    }
    row.status = 'CANCELLED';
    row.deletedAt = NOW;
    return Promise.resolve(true);
  }

  private toEntity(row: StoredPlan): PaymentPlanWithInstallments {
    const { deletedAt: _deletedAt, ...rest } = row;
    return {
      ...rest,
      installments: row.installments.map((i) => ({ ...i })),
    };
  }
}
