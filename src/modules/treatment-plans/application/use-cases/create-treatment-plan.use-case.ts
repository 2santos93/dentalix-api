import { Inject, Injectable } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';

// NOTE: deliberately NO `tenantId`/`status` field — tenant comes from the
// guarded request context (the repository reads it, never this input), and a
// newly created plan always starts DRAFT (the schema default).
export interface CreateTreatmentPlanInput {
  patientId: string;
  notes?: string;
  createdById?: string;
}

@Injectable()
export class CreateTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
  ) {}

  async execute(input: CreateTreatmentPlanInput): Promise<TreatmentPlan> {
    return this.repo.createPlan({
      patientId: input.patientId,
      notes: input.notes,
      createdById: input.createdById,
    });
  }
}
