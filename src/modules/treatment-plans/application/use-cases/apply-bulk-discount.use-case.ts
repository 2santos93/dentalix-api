import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscountReason } from '@prisma/client';
import {
  TREATMENT_PLAN_REPOSITORY,
  type BulkItemDiscount,
  type TreatmentPlanRepository,
} from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { GetDiscountPolicyUseCase } from '../../../discounts/application/use-cases/discount-policy.use-cases';
import {
  discountForPercent,
  roleDiscountCapMessage,
} from '../../../discounts/domain/discount-policy';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';
import { assertItemsEditable } from './signed-plan-lock';
import {
  assertPlanDiscountable,
  decideDiscount,
  type DiscountActor,
} from './item-discount';

export interface ApplyBulkDiscountInput {
  itemIds: string[];
  /** % (0..100, hasta 2 decimales) que se aplica a cada ítem. 0 los quita. */
  percent: number;
  discountReason?: DiscountReason;
  discountReasonNote?: string;
}

/**
 * Acción «Descuento %» sobre varios ítems de un plan (DX-204). A cada ítem se
 * le pone el `percent` % de SU precio, redondeado a la unidad de la moneda del
 * plan (COP sin decimales, EUR a céntimos). El tope del rol se comprueba antes
 * (un % por encima: 403 y nada cambia) y otra vez ítem a ítem: si el redondeo
 * lo llevara por encima, baja a la unidad que lo respeta. Por encima del
 * umbral, el motivo es obligatorio (422). Todo o nada, en una transacción.
 */
@Injectable()
export class ApplyBulkDiscountUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    private readonly discountPolicy: GetDiscountPolicyUseCase,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  async execute(
    planId: string,
    input: ApplyBulkDiscountInput,
    actor: DiscountActor,
  ): Promise<TreatmentPlanItem[]> {
    const plan = await this.repo.findPlanById(planId);
    if (!plan) {
      throw new NotFoundException('Plan de tratamiento no encontrado');
    }
    assertItemsEditable(plan);
    assertPlanDiscountable(plan);

    const policy = await this.discountPolicy.execute();
    const cap = policy.maxPercentByRole[actor.role] ?? 0;
    if (input.percent > cap) {
      throw new ForbiddenException(roleDiscountCapMessage(cap));
    }

    const at = this.now();
    return this.repo.applyBulkDiscount(planId, input.itemIds, (items) =>
      items.map((item): BulkItemDiscount => {
        const discount = discountForPercent(
          item.price,
          input.percent,
          plan.currency,
          cap,
        );
        return {
          itemId: item.id,
          discount,
          ...decideDiscount(
            policy,
            actor,
            {
              price: item.price,
              discount,
              reason: input.discountReason ?? null,
              reasonNote: input.discountReasonNote ?? null,
            },
            at,
          ),
        };
      }),
    );
  }
}
