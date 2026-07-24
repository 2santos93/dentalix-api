import { PaymentMethod } from '@prisma/client';

/**
 * API-facing shape of a Payment (Abono) — deliberately NOT the raw Prisma
 * model, same convention as Sale/TreatmentPlan. A Payment is registered
 * against a single `TreatmentPlan` (see docs/plans/2026-07-24-payments-pivot.md
 * "Modelo"); `patientId` is denormalized from the plan at creation time
 * (never accepted from the caller — see `RecordPaymentUseCase`). `amount` is
 * a plain `number` here (Prisma stores `Decimal(14,2)` — same convention as
 * `PrismaSaleRepository.mapToEntity` for `total`).
 */
export interface Payment {
  id: string;
  tenantId: string;
  treatmentPlanId: string;
  patientId: string;
  amount: number;
  currency: string;
  paidAt: Date;
  method: PaymentMethod | null;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
