import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { effectiveDiscount } from '../../../discounts/domain/effective-discount';
import { DiscountReason, ToothSurface } from '@prisma/client';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import {
  PRICING_SOURCE,
  type PricingSource,
} from '../../domain/ports/pricing-source.port';
import {
  PRICE_REQUIRED_MESSAGE,
  resolveItemPrice,
} from '../../domain/pricing/resolve-item-price';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { assertItemsEditable } from './signed-plan-lock';
import {
  assertDiscountAllowed,
  assertDiscountWithinPrice,
  assertPlanDiscountable,
  NO_DISCOUNT,
  decideDiscount,
  type DiscountActor,
} from './item-discount';
import { GetDiscountPolicyUseCase } from '../../../discounts/application/use-cases/discount-policy.use-cases';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';

/** 409 si la moneda del plan cambió entre la resolución del precio y el alta. */
export const PLAN_CURRENCY_CHANGED_MESSAGE =
  'La moneda del plan cambió mientras se añadía el ítem; vuelve a intentarlo.';

// NOTE: deliberately NO `tenantId`/`id`/`status` field — a new item always
// starts PROPOSED (the schema default). `price` is OPTIONAL: when omitted,
// it is the resolved reference price (DX-105: agreement → location price list
// → catalog `defaultPrice`, see `execute`).
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
    @Inject(PRICING_SOURCE)
    private readonly pricing: PricingSource,
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
    // DX-105: la resolución del precio necesita el paciente y la moneda del
    // plan, y se hace ANTES de la transacción del alta (solo lee).
    const current = await this.repo.findPlanById(planId);
    if (!current) {
      throw new NotFoundException('Treatment plan not found');
    }
    // `catalogItemId` must resolve to a real, active-tenant catalog item —
    // a cross-tenant or made-up id must never silently succeed (that would
    // let an item reference a procedure the tenant can't see/bill).
    const context = await this.pricing.contextFor(
      current.patientId,
      input.catalogItemId,
      current.currency,
    );
    if (!context) {
      throw new NotFoundException('Catalog item not found');
    }
    const resolved = resolveItemPrice(context);

    // Explicit price wins; otherwise the resolved reference. If neither is
    // available, the item has no price at all — a client error (400).
    const price = input.price ?? resolved.price ?? undefined;
    if (price === undefined) {
      throw new BadRequestException(PRICE_REQUIRED_MESSAGE);
    }
    const discount = input.discount ?? 0;
    assertDiscountWithinPrice(price, discount);
    // SEC-041 + DX-105 (R1): la referencia resuelta queda en el ítem como
    // `catalogPrice`; un precio por debajo cuenta como descuento discrecional
    // (tope del rol y motivo). Ítem libre: null.
    const discountInput = {
      catalogPrice: resolved.price,
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
      // Después del bloqueo: un plan firmado responde 409 antes que este 400.
      assertDiscountAllowed(resolved.allowDiscount, discountInput);
      if (plan.currency !== current.currency) {
        throw new ConflictException(PLAN_CURRENCY_CHANGED_MESSAGE);
      }
      let decision = NO_DISCOUNT;
      if (policy) {
        assertPlanDiscountable(plan);
        decision = decideDiscount(policy, actor, discountInput, at);
      }
      return {
        toothNumber: input.toothNumber,
        surfaces: input.surfaces,
        catalogItemId: input.catalogItemId,
        catalogPrice: resolved.price,
        pricing: {
          basePrice: resolved.basePrice,
          priceSource: resolved.source,
          agreementId: resolved.agreementId,
          agreementName: resolved.agreementName,
          pricingLocationId: context.locationId,
        },
        price,
        discount,
        notes: input.notes,
        createdById: actor.userId,
        ...decision,
      };
    });
  }
}
