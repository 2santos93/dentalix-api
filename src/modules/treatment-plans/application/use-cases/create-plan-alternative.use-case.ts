import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PLAN_OPTIONS_REPOSITORY,
  type PlanOptionsRepository,
} from '../../domain/ports/plan-options-repository.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';
import {
  defaultOptionLabel,
  hasClosedOption,
  nextOptionLabel,
  normalizeOptionLabel,
} from '../../domain/plan-options';
import { PLAN_NOT_FOUND_MESSAGE } from './plan-quote.use-cases';

export interface CreatePlanAlternativeInput {
  optionLabel?: string | null;
  /** Del token (req.user.sub), nunca del cuerpo. */
  createdById?: string;
}

export const OPTION_ALREADY_CHOSEN_MESSAGE =
  'El paciente ya eligió una opción de este grupo: no se pueden añadir alternativas.';

@Injectable()
export class CreatePlanAlternativeUseCase {
  constructor(
    @Inject(PLAN_OPTIONS_REPOSITORY)
    private readonly repo: PlanOptionsRepository,
  ) {}

  /**
   * Crea la opción siguiente de un plan (DX-040): un borrador del MISMO
   * paciente, con la misma moneda y una copia de los ítems, en el mismo grupo.
   * Si el plan aún era suelto, abre el grupo y pasa a ser la «Opción A». Un
   * grupo cuya opción ya se aceptó no admite más alternativas (409).
   */
  async execute(
    sourcePlanId: string,
    input: CreatePlanAlternativeInput,
  ): Promise<TreatmentPlan> {
    const created = await this.repo.createAlternative(
      sourcePlanId,
      ({ plan, siblings }) => {
        if (hasClosedOption([plan, ...siblings])) {
          throw new ConflictException(OPTION_ALREADY_CHOSEN_MESSAGE);
        }
        const sourceLabel = plan.optionLabel ?? defaultOptionLabel(0);
        return {
          sourceLabel,
          label:
            normalizeOptionLabel(input.optionLabel) ??
            nextOptionLabel([
              sourceLabel,
              ...siblings.map((sibling) => sibling.optionLabel),
            ]),
          createdById: input.createdById,
        };
      },
    );
    if (!created) throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    return created;
  }
}
