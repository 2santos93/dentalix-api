import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  TreatmentPlanItemStatus,
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  TREATMENT_PLAN_REPOSITORY,
  type TreatmentPlanRepository,
} from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';
import { planTransitionError } from '../../domain/plan-status-machine';
import {
  rejectionBlocker,
  rejectionInputError,
} from '../../domain/plan-options';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';

export interface RejectTreatmentPlanInput {
  reason: TreatmentPlanRejectionReason;
  note?: string | null;
}

@Injectable()
export class RejectTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  /**
   * PRESENTED → REJECTED (DX-040), con un motivo del catálogo («Otro» exige la
   * nota). Un plan con procedimientos realizados o abonos vivos no se rechaza
   * (409). Solo rechaza ESTE plan: las demás opciones del grupo siguen
   * presentadas, porque el paciente puede descartar una y quedarse con otra.
   */
  async execute(
    id: string,
    input: RejectTreatmentPlanInput,
  ): Promise<TreatmentPlan> {
    const inputError = rejectionInputError(input.reason, input.note);
    if (inputError) throw new BadRequestException(inputError);
    const note = input.note?.trim() || null;
    const at = this.now();
    return this.repo.updatePlan(id, (existing, facts) => {
      const error = planTransitionError(
        existing.status,
        TreatmentPlanStatus.REJECTED,
      );
      if (error) throw new ConflictException(error);
      // Ya cobrado o realizado: no se rechaza (se cancela, si hace falta).
      const blocker = rejectionBlocker({
        hasDoneItems: existing.items.some(
          (item) => item.status === TreatmentPlanItemStatus.DONE,
        ),
        hasLivePayments: facts.hasLivePayments,
      });
      if (blocker) throw new ConflictException(blocker);
      return {
        status: TreatmentPlanStatus.REJECTED,
        rejection: { at, reason: input.reason, note },
      };
    });
  }
}
