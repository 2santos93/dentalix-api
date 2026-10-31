import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlanDetail } from '../../domain/entities/treatment-plan.entity';
import { linesTotal } from '../../../../shared/money/line-rounding';

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

    // Total = Σ(price − discount) of active items (DX-012 added the per-item
    // discount; still no taxes). Computed here, on every read, NEVER persisted
    // on the plan row, so a soft-deleted item (already excluded by the
    // repository's `findPlanById`) can never linger in the total either.
    // DX-340: total = suma exacta de las líneas (shared/money/line-rounding),
    // la misma regla del presupuesto, el saldo, el recibo y el estado de
    // cuenta. Summed in integer cents: no floating point drift.
    const total = linesTotal(plan.items);

    return { ...plan, total };
  }
}
