import {
  CancelledPaymentPlan,
  Installment,
  PaymentPlanCancellation,
  PaymentPlanWithInstallments,
} from '../../../domain/entities/payment-plan.entity';
import {
  CreatePaymentPlanRepoInput,
  PaymentPlanRepository,
} from '../../../domain/ports/payment-plan-repository.port';

type StoredPlan = PaymentPlanWithInstallments & {
  deletedAt: Date | null;
  cancellation: PaymentPlanCancellation | null;
};

let seq = 0;
const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Real in-memory fake for `PaymentPlanRepository` — implements ACTUAL
 * filtering (ACTIVE + not soft-deleted, plan scoping) so use-case specs
 * genuinely exercise it. Mirrors PrismaPaymentPlanRepository semantics.
 */
export class InMemoryPaymentPlanRepository implements PaymentPlanRepository {
  private readonly plans: StoredPlan[] = [];

  /** DX-123: planes de tratamiento que existen (por defecto, todos). */
  existingTreatmentPlans: Set<string> | null = null;

  /** DX-123: nombre de cada usuario (las membresías de la clínica). */
  userNames = new Map<string, string>();

  /** DX-110: zona de la sede de cada plan de tratamiento (por defecto, Caracas). */
  timeZone = 'America/Caracas';

  planTimeZone(): Promise<string> {
    return Promise.resolve(this.timeZone);
  }

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
      cancellation: null,
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

  treatmentPlanExists(treatmentPlanId: string): Promise<boolean> {
    return Promise.resolve(
      this.existingTreatmentPlans === null ||
        this.existingTreatmentPlans.has(treatmentPlanId),
    );
  }

  findCancelledByPlan(
    treatmentPlanId: string,
  ): Promise<CancelledPaymentPlan[]> {
    const rows = this.plans
      .filter(
        (p) =>
          p.treatmentPlanId === treatmentPlanId && p.status === 'CANCELLED',
      )
      .map((p) => {
        const by = p.cancellation?.byId ?? null;
        return {
          id: p.id,
          currency: p.currency,
          totalToFinance: p.totalToFinance,
          downPayment: p.downPayment,
          installmentsCount: p.installmentsCount,
          periodicity: p.periodicity,
          startDate: p.startDate,
          createdAt: p.createdAt,
          cancelledAt: p.cancellation?.at ?? p.deletedAt ?? p.updatedAt,
          cancelledBy: by
            ? { id: by, fullName: this.userNames.get(by) ?? null }
            : null,
          cancelReason: p.cancellation?.reason ?? null,
        };
      })
      .sort((a, b) => b.cancelledAt.getTime() - a.cancelledAt.getTime());
    return Promise.resolve(rows);
  }

  cancel(id: string, cancellation: PaymentPlanCancellation): Promise<boolean> {
    const row = this.plans.find(
      (p) => p.id === id && p.status === 'ACTIVE' && p.deletedAt === null,
    );
    if (!row) {
      return Promise.resolve(false);
    }
    row.status = 'CANCELLED';
    row.deletedAt = cancellation.at;
    row.cancellation = cancellation;
    return Promise.resolve(true);
  }

  private toEntity(row: StoredPlan): PaymentPlanWithInstallments {
    const { deletedAt: _deletedAt, cancellation: _cancellation, ...rest } = row;
    return {
      ...rest,
      installments: row.installments.map((i) => ({ ...i })),
    };
  }
}
