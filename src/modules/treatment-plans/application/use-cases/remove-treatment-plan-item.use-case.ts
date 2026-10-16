import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { assertItemsEditable } from './signed-plan-lock';

@Injectable()
export class RemoveTreatmentPlanItemUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
  ) {}

  async execute(itemId: string): Promise<void> {
    const existing = await this.repo.findItemById(itemId);
    if (!existing) {
      throw new NotFoundException('Treatment plan item not found');
    }
    const plan = await this.repo.findPlanById(existing.planId);
    if (plan) assertItemsEditable(plan);

    // Soft-delete only — never a hard delete on a domain table.
    await this.repo.softDeleteItem(itemId);
  }
}
