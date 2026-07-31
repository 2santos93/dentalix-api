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
  /**
   * Idempotency-Key (UUID) for dedup. When set, persisted and covered by the
   * partial unique index (tenantId, idempotencyKey). `undefined` → stored as
   * NULL (unconstrained). Validated/normalized by RecordPaymentUseCase before
   * it reaches here (never taken raw from the client).
   */
  idempotencyKey?: string;
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

  /**
   * The payment carrying this Idempotency-Key in the current tenant (RLS-
   * scoped), or `null` if none. Deliberately NOT filtered by `deletedAt`:
   * idempotency means "same request → same row" regardless of whether that row
   * was later voided, so a replay never creates a duplicate.
   */
  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null>;

  /** Active payments (`deletedAt: null`) for a plan, ordered by `paidAt` DESC. */
  listByPlan(treatmentPlanId: string): Promise<Payment[]>;

  /** Active payments (`deletedAt: null`) for a patient, ordered by `paidAt` DESC. */
  listByPatient(patientId: string): Promise<Payment[]>;

  /**
   * Soft-delete (void): atomically sets `deletedAt` ONLY if the row is
   * currently active (`deletedAt: null`) -- a single check-and-set, not a
   * separate find then update, so two concurrent voids of the same payment
   * can't both "win" (TOCTOU race). Returns `true` if this call actually
   * voided the payment, `false` if it was already voided or doesn't exist
   * (never throws for that case -- the use case decides 404). Never a hard
   * delete.
   */
  softDelete(id: string): Promise<boolean>;

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
