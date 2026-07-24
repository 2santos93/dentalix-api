import { PaymentMethod } from '@prisma/client';
import { SaleLineItem } from './sale-line-item.entity';

/**
 * API-facing shape of a Sale. Deliberately NOT the raw Prisma model — same
 * convention as Appointment/TreatmentPlan. Unlike `TreatmentPlanDetail.total`
 * (computed on every read from active items), `total` here is a STORED
 * financial figure: it is calculated once by `CreateSaleUseCase` from the
 * line items at creation time and persisted on the row — a sale is an
 * immutable financial record in v1 (correcting one means voiding + creating
 * a new one, never editing lines in place). See `CreateSaleUseCase` for the
 * rounding policy.
 */
export interface Sale {
  id: string;
  tenantId: string;
  patientId: string | null;
  currency: string;
  total: number;
  paidAt: Date;
  paymentMethod: PaymentMethod | null;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Returned by `SaleRepository.create` / `findById` — the sale plus its line
 * items. Line items are never independently soft-deleted (see
 * `SaleLineItem`), so there is no "active items" filtering here the way
 * `TreatmentPlanWithItems` needs it.
 */
export interface SaleWithLineItems extends Sale {
  lineItems: SaleLineItem[];
}
