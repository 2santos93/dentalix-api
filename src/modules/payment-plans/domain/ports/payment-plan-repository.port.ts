import type { LockActor } from '../../../financial-lock/domain/financial-lock';
import { Periodicity } from '../../application/schedule/generate-schedule';
import {
  CancelledPaymentPlan,
  PaymentPlanCancellation,
  PaymentPlanWithInstallments,
} from '../entities/payment-plan.entity';

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
  /**
   * DX-091: quién crea el plan y su motivo para que alguna cuota venza en un
   * período contable cerrado (solo ADMIN con la exención de la clínica).
   */
  lockActor?: LockActor | null;
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
   * DX-123: ¿existe el plan de tratamiento (vivo, de esta clínica)? Distingue
   * «sin plan de cuotas» (200 null) de «plan inexistente» (404).
   */
  treatmentPlanExists(treatmentPlanId: string): Promise<boolean>;

  /**
   * DX-123 (O-2): los planes de cuotas CANCELADOS del plan de tratamiento, del
   * más reciente al más antiguo, con quién, cuándo y por qué.
   */
  findCancelledByPlan(treatmentPlanId: string): Promise<CancelledPaymentPlan[]>;

  /**
   * DX-110: la zona IANA de la sede del plan de tratamiento (la de su
   * aceptación o, sin ella, la de su presentación; sin ninguna, la principal):
   * su día civil es el «hoy» con que vencen las cuotas. Una sede sin zona
   * válida da 409 `LOCATION_TIMEZONE_REQUIRED` (nunca otra zona).
   */
  planTimeZone(treatmentPlanId: string): Promise<string>;

  /**
   * Atomically set status=CANCELLED + deletedAt ONLY if currently ACTIVE.
   * Returns true if THIS call cancelled it, false if already gone (never
   * throws — the use case decides 404). Never a hard delete.
   *
   * DX-092 (SEC-029): guarda quién, cuándo y por qué en la misma escritura.
   *
   * DX-091: un plan con cuotas que vencen en un período contable cerrado no
   * se cancela (409 PERIOD_LOCKED), salvo la excepción del ADMIN con motivo.
   */
  cancel(
    id: string,
    cancellation: PaymentPlanCancellation,
    lockActor?: LockActor | null,
  ): Promise<boolean>;
}
