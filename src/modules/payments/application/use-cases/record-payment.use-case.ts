import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type {
  CreatePaymentRepoInput,
  PaymentRepository,
} from '../../domain/ports/payment-repository.port';
import { Payment } from '../../domain/entities/payment.entity';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';

// NOTE: deliberately NO `patientId`/`treatmentPlanId` field on the input
// object itself (`treatmentPlanId` is a separate `execute()` argument,
// `patientId` is ALWAYS derived from the plan) — same convention as
// CreateSaleInput never accepting `total`/`amount` from the caller.
export interface RecordPaymentInput {
  amount: number;
  currency: string;
  /** ISO string or `Date` — normalized to `Date` before reaching the repo. */
  paidAt: string | Date;
  method?: PaymentMethod;
  notes?: string;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Idempotency-Key must be a UUID (the client contract). Validated here rather
// than via a DTO because it's a header, not a body field — same reason
// tenant/createdById live outside RecordPaymentInput.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RecordPaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    // Concrete class (not an interface port) injected directly, same
    // cross-module DI pattern as GetSalesTotalsUseCase injecting
    // ConvertAmountUseCase: reused so "does the plan exist" (NotFound if
    // absent/soft-deleted/cross-tenant) and "what's its patientId" live in
    // exactly one place, never re-implemented here.
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
  ) {}

  /**
   * `createdById` is a separate argument (not part of `input`) — it comes
   * from the guarded request context (`req.user`), never the client body,
   * same rationale as the tenant itself (see CreateSaleUseCase).
   */
  async execute(
    treatmentPlanId: string,
    input: RecordPaymentInput,
    createdById?: string,
    idempotencyKey?: string,
  ): Promise<Payment> {
    // Idempotency short-circuit FIRST — before any validation or plan lookup: a
    // replay must be cheap and must NOT re-run "does the plan still exist" (a
    // plan voided AFTER the original payment would otherwise make an honest
    // retry 404). Blank/whitespace header == no key (today's behavior).
    const key = idempotencyKey?.trim() ? idempotencyKey.trim() : undefined;
    if (key !== undefined) {
      if (!UUID_RE.test(key)) {
        throw new BadRequestException('Idempotency-Key must be a UUID');
      }
      const existing = await this.repo.findByIdempotencyKey(key);
      if (existing) {
        return existing;
      }
    }

    if (!isFinitePositive(input.amount)) {
      throw new BadRequestException('amount must be a finite number > 0');
    }

    if (!input.currency || input.currency.trim() === '') {
      throw new BadRequestException('currency is required');
    }
    const currency = input.currency.trim().toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(`Unknown currency: ${currency}`);
    }

    const paidAt =
      input.paidAt instanceof Date ? input.paidAt : new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime())) {
      throw new BadRequestException('paidAt must be a valid date');
    }

    // Throws NotFoundException when the plan is absent, soft-deleted, or
    // belongs to another tenant — never re-derived here.
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);

    const repoInput: CreatePaymentRepoInput = {
      treatmentPlanId,
      patientId: plan.patientId,
      amount: input.amount,
      currency,
      paidAt,
      method: input.method,
      notes: input.notes,
      createdById,
      idempotencyKey: key,
    };

    return this.repo.create(repoInput);
  }
}
