import { PaymentMethod } from '@prisma/client';
import { Sale, SaleWithLineItems } from '../entities/sale.entity';

// NOTE: deliberately NO `tenantId`/`id` field on the line items either — the
// tenant comes from the guarded request context (never the client), same
// convention as CreateAppointmentRepoInput/AddTreatmentPlanItemRepoInput.
// `amount` is REQUIRED here: the use case is the one that computes it
// (`unitPrice * quantity`, rounded — see CreateSaleUseCase) BEFORE calling
// the repository, so by the time this input reaches the repo the figure is
// already resolved and the repo never re-derives money math.
export interface CreateSaleLineItemRepoInput {
  description: string;
  catalogItemId?: string;
  treatmentPlanItemId?: string;
  unitPrice: number;
  quantity: number;
  amount: number;
}

// `total` is likewise REQUIRED and pre-computed by the use case (Σ line
// amounts) — the repository only persists it, it never sums the lines
// itself, so there is exactly one place (`CreateSaleUseCase`) responsible
// for the money math.
export interface CreateSaleRepoInput {
  patientId?: string;
  currency: string;
  total: number;
  paidAt: Date;
  paymentMethod?: PaymentMethod;
  notes?: string;
  createdById?: string;
  lineItems: CreateSaleLineItemRepoInput[];
}

export interface ListSalesByRangeParams {
  from?: Date;
  to?: Date;
  patientId?: string;
}

export interface ListSalesForTotalsParams {
  from: Date;
  to: Date;
}

/** Minimal projection consumed by `GetSalesTotalsUseCase` — one row per
 * active sale in the range, just enough to convert + group by currency. */
export interface SaleTotalsRow {
  id: string;
  currency: string;
  total: number;
  paidAt: Date;
}

export const SALE_REPOSITORY = Symbol('SALE_REPOSITORY');

export interface SaleRepository {
  /**
   * Creates the Sale and all of its line items atomically (one
   * `$transaction`) and returns the sale with its lines attached.
   */
  create(input: CreateSaleRepoInput): Promise<SaleWithLineItems>;

  /**
   * The sale plus its line items, or `null` if the sale is absent,
   * soft-deleted, or belongs to another tenant (RLS makes those
   * indistinguishable from "absent").
   */
  findById(id: string): Promise<SaleWithLineItems | null>;

  /**
   * Active sales (`deletedAt: null`), optionally narrowed to a `[from, to)`
   * `paidAt` window and/or a single patient, ordered by `paidAt` DESC.
   */
  listByRange(params: ListSalesByRangeParams): Promise<Sale[]>;

  /** Soft-delete (void): sets `deletedAt`. Never a hard delete. */
  softDelete(id: string): Promise<void>;

  /**
   * Active sales whose `paidAt` falls within `[from, to)` — the minimal
   * projection `GetSalesTotalsUseCase` needs to convert + group each sale,
   * without pulling line items along for the ride.
   */
  listForTotals(params: ListSalesForTotalsParams): Promise<SaleTotalsRow[]>;
}
