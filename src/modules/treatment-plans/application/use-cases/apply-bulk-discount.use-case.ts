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
import {
  DENTAL_CATALOG_REPOSITORY,
  type DentalCatalogRepository,
} from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';
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

/** Lo que devuelve la acción: los ítems descontados y cuántos se saltaron. */
export interface ApplyBulkDiscountResult {
  items: TreatmentPlanItem[];
  /** DX-105: ítems cuyo procedimiento no admite descuentos; no se tocan. */
  skippedNoDiscount: number;
}

/**
 * Acción «Descuento %» sobre varios ítems de un plan (DX-204). A cada ítem se
 * le pone el `percent` % de SU precio, redondeado a los dígitos de redondeo de
 * la moneda del plan (`currencies.rounding_digits`, DX-340: COP sin decimales,
 * EUR a céntimos). El tope del rol se comprueba antes
 * (un % por encima: 403 y nada cambia) y otra vez ítem a ítem: si el redondeo
 * lo llevara por encima, baja a la unidad que lo respeta. Por encima del
 * umbral, el motivo es obligatorio (422). Todo o nada, en una transacción.
 * DX-105: los ítems cuyo procedimiento no admite descuentos se saltan (no
 * cambian) y la respuesta dice cuántos.
 */
@Injectable()
export class ApplyBulkDiscountUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    private readonly discountPolicy: GetDiscountPolicyUseCase,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalog: DentalCatalogRepository,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
  ) {}

  async execute(
    planId: string,
    input: ApplyBulkDiscountInput,
    actor: DiscountActor,
  ): Promise<ApplyBulkDiscountResult> {
    const policy = await this.discountPolicy.execute();
    const cap = policy.maxPercentByRole[actor.role] ?? 0;
    if (input.percent > cap) {
      throw new ForbiddenException(roleDiscountCapMessage(cap));
    }

    const at = this.now();
    const reasonChanged =
      input.discountReason !== undefined ||
      input.discountReasonNote !== undefined;
    const noDiscount = await this.noDiscountCatalogItems(planId, input.itemIds);
    // La moneda del plan se lee con su fila bloqueada: se carga la tabla
    // entera (~150 filas, en caché) para no consultar dentro de la transacción.
    const digits = await this.currencyDigits.table();
    let skippedNoDiscount = 0;
    // BE-036: el estado del plan se valida con su fila bloqueada, dentro de
    // la transacción, junto a los ítems.
    const updated = await this.repo.applyBulkDiscount(
      planId,
      input.itemIds,
      ({ plan, items }) => {
        assertItemsEditable(plan);
        assertPlanDiscountable(plan);
        // Al 0 % no se salta ningún ítem: limpia descuentos antiguos y solo
        // puede bajar el descuento efectivo.
        const discountable =
          input.percent > 0
            ? items.filter((item) => !noDiscount.has(item.catalogItemId))
            : items;
        skippedNoDiscount = items.length - discountable.length;
        return discountable.map((item): BulkItemDiscount => {
          const discount = discountForPercent(
            item.price,
            input.percent,
            digits.roundingDigits(plan.currency),
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
    return { items: updated, skippedNoDiscount };
  }

  /**
   * Procedimientos (de los ítems pedidos) que no admiten descuentos. Se leen
   * antes de la transacción: el procedimiento de un ítem no cambia. Un ítem
   * que aún no existía en esta lectura no tiene entrada, y se salta (lado
   * seguro: nunca se descuenta lo que no se ha comprobado).
   */
  private async noDiscountCatalogItems(
    planId: string,
    itemIds: string[],
  ): Promise<{ has(catalogItemId: string): boolean }> {
    const plan = await this.repo.findPlanById(planId);
    const wanted = new Set(itemIds);
    const catalogIds = [
      ...new Set(
        (plan?.items ?? [])
          .filter((item) => wanted.has(item.id))
          .map((item) => item.catalogItemId),
      ),
    ];
    const catalogItems =
      catalogIds.length > 0 ? await this.catalog.findByIds(catalogIds) : [];
    const allowed = new Set(
      catalogItems.filter((c) => c.allowDiscount).map((c) => c.id),
    );
    return { has: (catalogItemId) => !allowed.has(catalogItemId) };
  }
}
