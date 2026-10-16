import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import {
  TREATMENT_PLAN_REPOSITORY,
  type TreatmentPlanRepository,
} from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';
import { planTransitionError } from '../../domain/plan-status-machine';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';

export const PRESENT_WITHOUT_ITEMS_MESSAGE =
  'El plan no tiene ítems: agrega al menos un procedimiento antes de presentarlo.';

@Injectable()
export class PresentTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  /**
   * DRAFT → PRESENTED (DX-040): el presupuesto se le presentó al paciente. Se
   * guarda la hora del servidor y la sede (la del request o la principal),
   * que es desde donde lo sigue recepción. Un plan sin ítems no se presenta.
   */
  async execute(id: string): Promise<TreatmentPlan> {
    const at = this.now();
    return this.repo.updatePlan(id, (existing) => {
      const error = planTransitionError(
        existing.status,
        TreatmentPlanStatus.PRESENTED,
      );
      if (error) throw new ConflictException(error);
      if (existing.items.length === 0) {
        throw new BadRequestException(PRESENT_WITHOUT_ITEMS_MESSAGE);
      }
      return { status: TreatmentPlanStatus.PRESENTED, presentation: { at } };
    });
  }
}
