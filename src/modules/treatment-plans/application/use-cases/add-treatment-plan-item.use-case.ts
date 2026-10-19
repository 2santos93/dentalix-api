import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { effectiveDiscount } from '../../../discounts/domain/effective-discount';
import { DiscountReason, ToothSurface } from '@prisma/client';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { DENTAL_CATALOG_REPOSITORY } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { assertItemsEditable } from './signed-plan-lock';
import {
  assertDiscountWithinPrice,
  assertPlanDiscountable,
  NO_DISCOUNT,
  decideDiscount,
  type DiscountActor,
} from './item-discount';
import { GetDiscountPolicyUseCase } from '../../../discounts/application/use-cases/discount-policy.use-cases';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';

// NOTE: deliberately NO `tenantId`/`id`/`status` field — a new item always
// starts PROPOSED (the schema default). `price` is OPTIONAL: when omitted,
// it is resolved from the catalog item's `defaultPrice` (see `execute`).
export interface AddTreatmentPlanItemInput {
  toothNumber: string;
  surfaces?: ToothSurface[];
  catalogItemId: string;
  price?: number;
  /** Descuento en la moneda del plan; 0 si se omite, nunca mayor que el precio. */
  discount?: number;
  /** DX-204: obligatorio por encima del umbral de la política. */
  discountReason?: DiscountReason;
  discountReasonNote?: string;
  notes?: string;
}

@Injectable()
export class AddTreatmentPlanItemUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalogRepo: DentalCatalogRepository,
    private readonly discountPolicy: GetDiscountPolicyUseCase,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  /**
   * `actor` (usuario y rol del token) decide el tope del descuento (DX-204):
   * la política se aplica aquí, en el servidor, no solo en la web.
   */
  async execute(
    planId: string,
    input: AddTreatmentPlanItemInput,
    actor: DiscountActor,
  ): Promise<TreatmentPlanItem> {
    // `catalogItemId` must resolve to a real, active-tenant catalog item —
    // a cross-tenant or made-up id must never silently succeed (that would
    // let an item reference a procedure the tenant can't see/bill).
    const catalogItem = await this.catalogRepo.findById(input.catalogItemId);
    if (!catalogItem) {
      throw new NotFoundException('Catalog item not found');
    }

    // Explicit price wins; otherwise fall back to the catalog item's
    // defaultPrice. If neither is available, the item has no price at all —
    // that's a client error (400), not a server error.
    const price = input.price ?? catalogItem.defaultPrice ?? undefined;
    if (price === undefined) {
      throw new BadRequestException('price is required');
    }
    const discount = input.discount ?? 0;
    assertDiscountWithinPrice(price, discount);
    // SEC-041: el precio de catálogo queda en el ítem; un precio por debajo
    // cuenta como descuento (tope del rol y motivo). Ítem libre: null.
    const discountInput = {
      catalogPrice: catalogItem.defaultPrice,
      price,
      discount,
      reason: input.discountReason ?? null,
      reasonNote: input.discountReasonNote ?? null,
    };
    const discounted = effectiveDiscount(discountInput).total > 0;
    const policy = discounted ? await this.discountPolicy.execute() : null;
    const at = this.now();

    // BE-036: el estado del plan se valida con su fila bloqueada, dentro de
    // la transacción del alta.
    return this.repo.addItem(planId, (plan) => {
      assertItemsEditable(plan);
      let decision = NO_DISCOUNT;
      if (policy) {
        assertPlanDiscountable(plan);
        decision = decideDiscount(policy, actor, discountInput, at);
      }
      return {
        toothNumber: input.toothNumber,
        surfaces: input.surfaces,
        catalogItemId: input.catalogItemId,
        catalogPrice: catalogItem.defaultPrice,
        price,
        discount,
        notes: input.notes,
        ...decision,
      };
    });
  }
}
