import { Inject, Injectable } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';

@Injectable()
export class ListTreatmentPlansUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
  ) {}

  /**
   * Ordering (createdAt DESC) and the active/deletedAt:null filter are the
   * repository's responsibility — this use case only forwards `patientId`
   * untouched.
   */
  async execute(patientId: string): Promise<TreatmentPlan[]> {
    return this.repo.listPlansByPatient(patientId);
  }
}
