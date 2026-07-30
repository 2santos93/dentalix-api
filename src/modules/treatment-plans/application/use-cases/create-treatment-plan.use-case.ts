import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { CURRENCY_WHITELIST } from '../../domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';

// NOTE: deliberately NO `tenantId`/`status` field — tenant comes from the
// guarded request context (the repository reads it, never this input), and a
// newly created plan always starts DRAFT (the schema default).
export interface CreateTreatmentPlanInput {
  patientId: string;
  currency?: string;
  notes?: string;
  createdById?: string;
}

@Injectable()
export class CreateTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
  ) {}

  async execute(input: CreateTreatmentPlanInput): Promise<TreatmentPlan> {
    // Default "USD" (the schema default) when omitted — validated against
    // the seeded `currencies` table either way, so a client can't force an
    // unknown code by omission or by an explicit-but-wrong value.
    const currency = (input.currency ?? 'USD').toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(`Unknown currency: ${currency}`);
    }

    return this.repo.createPlan({
      patientId: input.patientId,
      currency,
      notes: input.notes,
      createdById: input.createdById,
    });
  }
}
