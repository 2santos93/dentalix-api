import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
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
  needsReferenceSnapshot,
  referenceInPlan,
  referenceRateCurrency,
  type ReferenceSnapshot,
} from '../../../discounts/domain/reference-in-plan';
import {
  NO_REFERENCE_RATES,
  REFERENCE_RATE_SOURCE,
  type ReferenceRateLookup,
  type ReferenceRateSource,
} from '../../domain/ports/reference-rate-source.port';
import { freezeWithRate } from './reference-rate';
import { PLAN_CURRENCY_CHANGED_MESSAGE } from './add-treatment-plan-item.use-case';
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
 * la moneda del plan (`currencies.rounding_digits`, DX-340: JPY sin decimales,
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
    // DX-513-bis: sin fuente (specs que no la necesitan), «sin tasa».
    @Optional()
    @Inject(REFERENCE_RATE_SOURCE)
    private readonly rates: ReferenceRateSource = NO_REFERENCE_RATES,
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
    // La moneda del plan se lee con su fila bloqueada, dentro de la
    // transacción; la tabla de decimales se carga antes (en caché) con la
    // moneda que el plan tiene ahora, para que una moneda dada de alta
    // después no falte dentro de la transacción.
    const current = await this.repo.findPlanById(planId);
    const digits = await this.currencyDigits.table(
      current ? [current.currency] : [],
    );
    // DX-513-bis §5.8: los ítems anteriores sin foto con la referencia en
    // otra moneda conocida la toman al recibir el %: una tasa por moneda,
    // pedida antes de la transacción. Al 0 % solo se quita descuento.
    const snapshotRates =
      current && input.percent > 0
        ? await this.legacySnapshotRates(
            current.items,
            input.itemIds,
            current.currency,
          )
        : new Map<string, ReferenceRateLookup>();
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
          // DX-513-bis: la rebaja se mide frente a la referencia en la moneda
          // del plan (la foto; en un ítem anterior, la que se toma hoy).
          let reference: ReferenceSnapshot | undefined;
          const currency = referenceRateCurrency(item, plan.currency);
          if (
            input.percent > 0 &&
            currency !== null &&
            needsReferenceSnapshot(item, plan.currency)
          ) {
            const lookup = snapshotRates.get(currency);
            if (!lookup || current?.currency !== plan.currency) {
              throw new ConflictException(PLAN_CURRENCY_CHANGED_MESSAGE);
            }
            reference = freezeWithRate(item, plan.currency, {
              currency,
              lookup,
            });
          }
          const before = {
            catalogPrice: reference
              ? reference.referencePriceInPlan
              : referenceInPlan(item, plan.currency),
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
          return {
            itemId: item.id,
            discount,
            ...decision,
            ...(reference ? { reference } : {}),
          };
        });
      },
    );
    return { items: updated, skippedNoDiscount };
  }

  /**
   * DX-513-bis §5.8: la tasa de hoy de cada moneda de referencia de los ítems
   * pedidos que aún no tienen foto (anteriores) y la necesitan.
   */
  private async legacySnapshotRates(
    items: readonly TreatmentPlanItem[],
    itemIds: readonly string[],
    planCurrency: string,
  ): Promise<Map<string, ReferenceRateLookup>> {
    const wanted = new Set(itemIds);
    const currencies = new Set(
      items
        .filter(
          (item) =>
            wanted.has(item.id) && needsReferenceSnapshot(item, planCurrency),
        )
        .map((item) => referenceRateCurrency(item, planCurrency))
        .filter((currency): currency is string => currency !== null),
    );
    const lookups = new Map<string, ReferenceRateLookup>();
    for (const currency of currencies) {
      lookups.set(currency, await this.rates.rateFor(currency, planCurrency));
    }
    return lookups;
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
