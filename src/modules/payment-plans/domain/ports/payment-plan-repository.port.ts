import { Periodicity } from '../../application/schedule/generate-schedule';
import { PaymentPlanWithInstallments } from '../entities/payment-plan.entity';

// NOTE: deliberately NO `tenantId`/`id` — tenant comes from request context,
// never the client (same convention as CreatePaymentRepoInput). `patientId`
// is always derived from the treatment plan before the repo is called.
export interface CreatePaymentPlanRepoInput {
  treatmentPlanId: string;
  patientId: string;
  currency: string;
  totalToFinance: number;
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: Date;
  notes?: string;
  createdById?: string;
  installments: { sequence: number; dueDate: Date; amount: number }[];
}

export const PAYMENT_PLAN_REPOSITORY = Symbol('PAYMENT_PLAN_REPOSITORY');

export interface PaymentPlanRepository {
  /** Persist the plan + its installments atomically. */
  create(
    input: CreatePaymentPlanRepoInput,
  ): Promise<PaymentPlanWithInstallments>;

  /**
   * The single ACTIVE plan for a treatment plan, or null. Soft-deleted /
   * CANCELLED / cross-tenant rows are invisible (RLS + status filter).
   */
  findActiveByPlan(
    treatmentPlanId: string,
  ): Promise<PaymentPlanWithInstallments | null>;

  /**
   * Atomically set status=CANCELLED + deletedAt ONLY if currently ACTIVE.
   * Returns true if THIS call cancelled it, false if already gone (never
   * throws — the use case decides 404). Never a hard delete.
   */
  cancel(id: string): Promise<boolean>;
}
