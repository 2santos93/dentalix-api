import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
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
  decideDiscountChange,
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
    const policy = await this.discountPolicy.execute();
    const cap = policy.maxPercentByRole[actor.role] ?? 0;
    if (input.percent > cap) {
      throw new ForbiddenException(roleDiscountCapMessage(cap));
    }

    const at = this.now();
    const reasonChanged =
      input.discountReason !== undefined ||
      input.discountReasonNote !== undefined;
    // BE-036: el estado del plan se valida con su fila bloqueada, dentro de
    // la transacción, junto a los ítems.
    return this.repo.applyBulkDiscount(
      planId,
      input.itemIds,
      ({ plan, items }) => {
        assertItemsEditable(plan);
        assertPlanDiscountable(plan);
        return items.map((item): BulkItemDiscount => {
          const discount = discountForPercent(
            item.price,
            input.percent,
            plan.currency,
            cap,
          );
          const before = {
            catalogPrice: item.catalogPrice,
            price: item.price,
            discount: item.discount,
          };
          // SEC-041: el tope se mide sobre el descuento efectivo (la rebaja de
          // precio del ítem + el % aplicado).
          const decision = decideDiscountChange(
            policy,
            actor,
            before,
            {
              ...before,
              discount,
              reason: input.discountReason ?? null,
              reasonNote: input.discountReasonNote ?? null,
            },
            { discountSet: true, reasonChanged },
            at,
          );
          return { itemId: item.id, discount, ...decision };
        });
      },
    );
  }
}
