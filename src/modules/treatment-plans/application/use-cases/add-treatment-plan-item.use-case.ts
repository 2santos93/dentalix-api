import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { effectiveDiscount } from '../../../discounts/domain/effective-discount';
import { DiscountReason, ToothSurface } from '@prisma/client';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import {
  PRICING_SOURCE,
  type PricingSource,
} from '../../domain/ports/pricing-source.port';
import { PRICE_REQUIRED_MESSAGE } from '../../domain/pricing/resolve-item-price';
import { resolveCurrentReference } from '../current-reference';
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
import {
  NO_REFERENCE_RATES,
  REFERENCE_RATE_SOURCE,
  type ReferenceRateSource,
} from '../../domain/ports/reference-rate-source.port';
import { freezeWithRate, withAgreementBase } from './reference-rate';

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
  private readonly logger = new Logger(AddTreatmentPlanItemUseCase.name);

  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(PRICING_SOURCE)
    private readonly pricing: PricingSource,
    private readonly discountPolicy: GetDiscountPolicyUseCase,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
    // DX-513-bis: sin fuente (specs que no la necesitan), «sin tasa».
    @Optional()
    @Inject(REFERENCE_RATE_SOURCE)
    private readonly rates: ReferenceRateSource = NO_REFERENCE_RATES,
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
    // DX-379 (D.1): la misma resolución que `price-quote` y la recotización.
    const currentReference = await resolveCurrentReference(
      this.pricing,
      this.rates,
      current.patientId,
      input.catalogItemId,
      current.currency,
    );
    if (!currentReference) {
      throw new NotFoundException(
        'Prestación no encontrada en el catálogo de esta clínica.',
      );
    }
    const { context, resolved, catalogCurrency, priced, asked } =
      currentReference;
    // DX-513-bis: la referencia en la moneda del plan. En otra moneda conocida
    // se convierte con la tasa de la clínica de hoy en la sede de escritura
    // (pedida ANTES de la transacción, como la política) y se congela con el
    // ítem; sin tasa, 422 y no se escribe nada. En la del plan (o en una que
    // no se sabe) es la de siempre, sin pedir tasa.
    // Un plan firmado o cerrado responde su 409 antes que «sin tasa» (422): el
    // problema es el plan, no la tasa. Se repite con la fila bloqueada.
    if (asked?.lookup.kind === 'missing') assertItemsEditable(current);
    // DX-513-ter: en una lista de convenio con el catálogo en otra moneda, la
    // base convertida con la tasa de hoy, solo para el informe. Sin tasa (o
    // con cualquier error) el ítem se crea igual, sin ella: nunca bloquea.
    const reference = await withAgreementBase(
      this.rates,
      priced,
      current.currency,
      freezeWithRate(priced, current.currency, asked, actor.role),
      (message) => this.logger.warn(message),
    );

    // Explicit price wins; otherwise the reference in the plan's currency
    // (DX-513-bis: nunca el `defaultPrice` crudo de otra moneda). If neither
    // is available, the item has no price at all — a client error (400).
    const price = input.price ?? reference.referencePriceInPlan ?? undefined;
    if (price === undefined) {
      throw new BadRequestException(PRICE_REQUIRED_MESSAGE);
    }
    const discount = input.discount ?? 0;
    assertDiscountWithinPrice(price, discount);
    // SEC-041 + DX-105 (R1): la referencia resuelta queda en el ítem como
    // `catalogPrice`; un precio por debajo cuenta como descuento discrecional
    // (tope del rol y motivo). Ítem libre: null. DX-513-bis: se mide frente a
    // la referencia en la moneda del plan (tope, motivo y `allowDiscount`).
    const discountInput = {
      catalogPrice: reference.referencePriceInPlan,
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
          catalogCurrency,
          priceSource: resolved.source,
          agreementId: resolved.agreementId,
          agreementName: resolved.agreementName,
          pricingLocationId: context.locationId,
          reference,
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
