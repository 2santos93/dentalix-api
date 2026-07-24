import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { SALE_REPOSITORY } from '../../domain/ports/sale-repository.port';
import type {
  CreateSaleRepoInput,
  SaleRepository,
} from '../../domain/ports/sale-repository.port';
import { SaleWithLineItems } from '../../domain/entities/sale.entity';

// NOTE: deliberately NO `tenantId`/`id`/`total`/`amount` field — the tenant
// comes from the guarded request context (never the client), and `total`/
// `amount` are DERIVED by this use case from `unitPrice * quantity`, never
// accepted from the caller (same convention as
// AddTreatmentPlanItemUseCase resolving `price` before the repo call).
export interface CreateSaleLineItemInput {
  description: string;
  catalogItemId?: string;
  treatmentPlanItemId?: string;
  unitPrice: number;
  quantity: number;
}

export interface CreateSaleInput {
  patientId?: string;
  currency: string;
  /** ISO string or `Date` — normalized to `Date` before reaching the repo. */
  paidAt: string | Date;
  paymentMethod?: PaymentMethod;
  notes?: string;
  lineItems: CreateSaleLineItemInput[];
}

// Monetary rounding policy: both the per-line `amount` (`unitPrice *
// quantity`) and the sale `total` (Σ line amounts) are rounded to 2 decimal
// places (round-half-away-from-zero on the cent value via `Math.round`).
// Floating point multiplication/summation can accumulate sub-cent drift
// (e.g. `0.1 + 0.2 !== 0.3`); rounding at BOTH steps — each line first, then
// the sum — keeps the persisted figures exact currency values instead of
// carrying that drift into a stored, immutable financial record. Same
// convention as `ConvertAmountUseCase`'s `result` rounding.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

@Injectable()
export class CreateSaleUseCase {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly repo: SaleRepository,
  ) {}

  /**
   * `createdById` is a separate argument (not part of `input`) — it comes
   * from the guarded request context (`req.user`, wired in Task 3), never
   * from the client body, same rationale as the tenant itself.
   */
  async execute(
    input: CreateSaleInput,
    createdById?: string,
  ): Promise<SaleWithLineItems> {
    if (!input.lineItems || input.lineItems.length === 0) {
      throw new BadRequestException('at least one line item is required');
    }

    if (!input.currency || input.currency.trim() === '') {
      throw new BadRequestException('currency is required');
    }
    const currency = input.currency.trim().toUpperCase();

    const paidAt =
      input.paidAt instanceof Date ? input.paidAt : new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime())) {
      throw new BadRequestException('paidAt must be a valid date');
    }

    const lineItems = input.lineItems.map((line) => {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        throw new BadRequestException('quantity must be an integer >= 1');
      }
      if (!isFiniteNonNegative(line.unitPrice)) {
        throw new BadRequestException('unitPrice must be a finite number >= 0');
      }

      return {
        description: line.description,
        catalogItemId: line.catalogItemId,
        treatmentPlanItemId: line.treatmentPlanItemId,
        unitPrice: line.unitPrice,
        quantity: line.quantity,
        amount: round2(line.unitPrice * line.quantity),
      };
    });

    const total = round2(lineItems.reduce((sum, line) => sum + line.amount, 0));

    const repoInput: CreateSaleRepoInput = {
      patientId: input.patientId,
      currency,
      total,
      paidAt,
      paymentMethod: input.paymentMethod,
      notes: input.notes,
      createdById,
      lineItems,
    };

    return this.repo.create(repoInput);
  }
}
