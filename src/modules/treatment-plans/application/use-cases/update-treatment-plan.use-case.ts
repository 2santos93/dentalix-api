import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type {
  TreatmentPlanRepository,
  UpdateTreatmentPlanRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';

export type UpdateTreatmentPlanInput = UpdateTreatmentPlanRepoInput;

@Injectable()
export class UpdateTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
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

    return this.repo.updatePlan(id, patch);
  }
}
