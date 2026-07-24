import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type {
  TreatmentPlanRepository,
  UpdateTreatmentPlanItemRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';

export type UpdateTreatmentPlanItemInput = UpdateTreatmentPlanItemRepoInput;

@Injectable()
export class UpdateTreatmentPlanItemUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
  ) {}

  async execute(
    itemId: string,
    patch: UpdateTreatmentPlanItemInput,
  ): Promise<TreatmentPlanItem> {
    const existing = await this.repo.findItemById(itemId);
    if (!existing) {
      throw new NotFoundException('Treatment plan item not found');
    }

    return this.repo.updateItem(itemId, patch);
  }
}
