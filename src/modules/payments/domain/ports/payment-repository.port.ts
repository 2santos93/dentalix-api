import { PaymentMethod } from '@prisma/client';
import { Payment } from '../entities/payment.entity';

// NOTE: deliberately NO `tenantId`/`id` field — the tenant comes from the
// guarded request context (never the client), same convention as
// CreateSaleRepoInput/AddTreatmentPlanItemRepoInput. `patientId` IS required
// here (unlike CreateSaleRepoInput's optional one): it is ALWAYS derived
// from the treatment plan by `RecordPaymentUseCase` before the repo is
// called, never accepted from the caller directly.
export interface CreatePaymentRepoInput {
  treatmentPlanId: string;
  patientId: string;
  amount: number;
  currency: string;
  paidAt: Date;
  method?: PaymentMethod;
  notes?: string;
  createdById?: string;
}

export interface ListPaymentsReceivedInRangeParams {
  from: Date;
  to: Date;
}

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

export interface PaymentRepository {
  create(input: CreatePaymentRepoInput): Promise<Payment>;

  /**
   * The payment, or `null` if it is absent, soft-deleted (voided), or
   * belongs to another tenant (RLS makes those indistinguishable from
   * "absent").
   */
  findById(id: string): Promise<Payment | null>;

  /** Active payments (`deletedAt: null`) for a plan, ordered by `paidAt` DESC. */
  listByPlan(treatmentPlanId: string): Promise<Payment[]>;

  /** Soft-delete (void): sets `deletedAt`. Never a hard delete. */
  softDelete(id: string): Promise<void>;

  /**
   * Active payments (any plan/patient) whose `paidAt` falls within
   * `[from, to)` — the projection `GetPaymentsTotalsUseCase` needs for the
   * dashboard "incomes of the period" metric (mirrors
   * `SaleRepository.listForTotals`).
   */
  listReceivedInRange(
    params: ListPaymentsReceivedInRangeParams,
  ): Promise<Payment[]>;
}
