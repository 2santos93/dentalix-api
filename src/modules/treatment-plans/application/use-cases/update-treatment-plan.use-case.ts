import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type {
  TreatmentPlanRepository,
  UpdateTreatmentPlanRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import { CURRENCY_WHITELIST } from '../../domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';

export type UpdateTreatmentPlanInput = UpdateTreatmentPlanRepoInput;

@Injectable()
export class UpdateTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
  ) {}

  async execute(
    id: string,
    patch: UpdateTreatmentPlanInput,
  ): Promise<TreatmentPlan> {
    const existing = await this.repo.findPlanById(id);
    if (!existing) {
      // Same rationale as UpdateAppointmentUseCase: a missing row and a row
      // that belongs to another tenant are indistinguishable here (RLS makes
      // cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Treatment plan not found');
    }

    // Only validate when the caller actually wants to change the currency —
    // an omitted `currency` must never re-validate (or otherwise touch) the
    // plan's existing one.
    let normalizedPatch = patch;
    if (patch.currency !== undefined) {
      const currency = patch.currency.toUpperCase();
      if (!(await this.whitelist.has(currency))) {
        throw new BadRequestException(`Unknown currency: ${currency}`);
      }
      normalizedPatch = { ...patch, currency };
    }

    return this.repo.updatePlan(id, normalizedPatch);
  }
}
