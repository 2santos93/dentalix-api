import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlanDetail } from '../../domain/entities/treatment-plan.entity';

@Injectable()
export class GetTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
  ) {}

  async execute(id: string): Promise<TreatmentPlanDetail> {
    const plan = await this.repo.findPlanById(id);
    if (!plan) {
      // Same rationale as GetAppointmentUseCase: a missing row and a row
      // that belongs to another tenant are indistinguishable here (RLS makes
      // cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Treatment plan not found');
    }

    // v1: total is a simple sum of active items' price — no discounts/taxes
    // (see plan doc "Notas"). Computed here, on every read, NEVER persisted
    // on the plan row, so a soft-deleted item (already excluded by the
    // repository's `findPlanById`) can never linger in the total either.
    const total = plan.items.reduce((sum, item) => sum + item.price, 0);

    return { ...plan, total };
  }
}
