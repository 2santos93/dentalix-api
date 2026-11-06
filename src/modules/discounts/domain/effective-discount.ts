import { ClinicRole, DiscountReason, PriceSource } from '@prisma/client';
import {
  checkItemDiscount,
  roleDiscountCapMessage,
  type DiscountPolicyRules,
  type ItemDiscountCheck,
} from './discount-policy';
import { fromCents, toCents } from '../../../shared/money/money';

/**
 * Descuento EFECTIVO de un ítem del plan (SEC-041). El tope por rol de DX-204
 * vigilaba solo el campo `discount`; bajar el precio por debajo del de
 * catálogo conseguía lo mismo sin control. Ahora cuenta todo:
 *
 *   efectivo = max(0, precioDeCatálogo − precio) + descuento
 *
 * y se compara, en %, sobre el precio de referencia (el de catálogo si el
 * precio está por debajo; si no, el precio). Subir el precio sigue libre: no
 * hay descuento negativo. Un ítem libre (sin precio de catálogo) solo cuenta
 * su `discount`. Todo en céntimos enteros (BigInt), como DX-204.
 */
export interface PricedItem {
  /**
   * Referencia de la rebaja (`discountReference`, DX-513); null = ítem libre o
   * referencia en OTRA moneda conocida.
   */
  catalogPrice: number | null;
  price: number;
  discount: number;
}

/**
 * DX-513: de dónde sale la moneda de la referencia (`catalogPrice`) de un ítem.
 * `catalogCurrency` (DX-502) es la de `basePrice`, el `defaultPrice` del
 * catálogo; la referencia no siempre lo es:
 *
 * - `PRICE_LIST` y `AGREEMENT_PRICE_LIST`: la resolución (DX-105) solo toma
 *   una lista en la moneda del plan, así que la referencia está en ella.
 * - `CATALOG`, `AGREEMENT_PERCENT` (un % sobre el `defaultPrice`) y los ítems
 *   anteriores a DX-105 (`priceSource` null): la del catálogo.
 */
export interface ItemReference {
  catalogPrice: number | null;
  catalogCurrency: string | null;
  priceSource: PriceSource | null;
}

const PLAN_CURRENCY_SOURCES: ReadonlySet<PriceSource> = new Set([
  PriceSource.PRICE_LIST,
  PriceSource.AGREEMENT_PRICE_LIST,
]);

/** Moneda de `catalogPrice`; `null` si no se sabe. */
export function referenceCurrency(
  item: Pick<ItemReference, 'catalogCurrency' | 'priceSource'>,
  planCurrency: string,
): string | null {
  if (
    item.priceSource !== null &&
    PLAN_CURRENCY_SOURCES.has(item.priceSource)
  ) {
    return planCurrency;
  }
  return item.catalogCurrency;
}

/**
 * DX-513: ¿la referencia está en una moneda CONOCIDA distinta de la del plan?
 * Solo entonces bajar de ella no es un descuento. Decisión de producto (fix
 * round 1): con la moneda desconocida (`catalogCurrency` NULL: sedes en
 * monedas distintas, o ítems anteriores al relleno de DX-502) no se puede
 * probar que no lo sea, así que cuenta como hoy (SEC-041): el control no se
 * salta en una clínica de varias monedas ni salen ítems de informes pasados.
 */
export function referenceInOtherCurrency(
  item: Pick<ItemReference, 'catalogCurrency' | 'priceSource'>,
  planCurrency: string,
): boolean {
  const currency = referenceCurrency(item, planCurrency);
  return currency !== null && currency !== planCurrency;
}

/**
 * DX-513: la referencia con la que se mide la rebaja de precio, o `null`. Un
 * precio por debajo de una referencia en OTRA moneda conocida no es un
 * descuento (no se resta ni se convierte): el ítem cuenta como libre y solo
 * su `discount` (en la moneda del plan) consume el tope o pide motivo. En la
 * misma moneda, o en una que no se sabe, la referencia de siempre (SEC-041).
 */
export function discountReference(
  item: ItemReference,
  planCurrency: string,
): number | null {
  return referenceInOtherCurrency(item, planCurrency)
    ? null
    : item.catalogPrice;
}

export interface EffectiveDiscount {
  /** Precio de referencia del %: el de catálogo si se rebajó; si no, el precio. */
  listPrice: number;
  /** Rebaja de precio frente al catálogo (0 si no la hay). */
  priceReduction: number;
  /** El campo `discount` del ítem. */
  itemDiscount: number;
  /** Rebaja de precio + descuento. */
  total: number;
}

function cents(amount: number): bigint {
  return BigInt(toCents(amount));
}

function amountOf(value: bigint): number {
  return fromCents(Number(value));
}

function effectiveCents(item: PricedItem): {
  list: bigint;
  reduction: bigint;
  total: bigint;
} {
  const price = cents(item.price);
  const catalog = item.catalogPrice === null ? null : cents(item.catalogPrice);
  const reduction = catalog !== null && catalog > price ? catalog - price : 0n;
  return {
    list: price + reduction,
    reduction,
    total: reduction + cents(item.discount),
  };
}

export function effectiveDiscount(item: PricedItem): EffectiveDiscount {
  const { list, reduction, total } = effectiveCents(item);
  return {
    listPrice: amountOf(list),
    priceReduction: amountOf(reduction),
    itemDiscount: item.discount,
    total: amountOf(total),
  };
}

/**
 * ¿El cambio sube el % efectivo del ítem? (total / referencia, comparado en
 * céntimos con producto cruzado). Bajar el precio por debajo del catálogo o de
 * un ítem con descuento lo sube; subir el precio nunca.
 */
export function effectiveDiscountRises(
  before: PricedItem,
  after: PricedItem,
): boolean {
  const b = effectiveCents(before);
  const a = effectiveCents(after);
  if (a.total === 0n) return false;
  if (b.total === 0n) return true;
  return a.total * b.list > b.total * a.list;
}

export const PRICE_BELOW_CATALOG_NOTICE =
  'Precio por debajo del de catálogo: cuenta como descuento.';

export function priceBelowCatalogCapMessage(maxPercent: number): string {
  return `${PRICE_BELOW_CATALOG_NOTICE} ${roleDiscountCapMessage(maxPercent)}`;
}

export function priceBelowCatalogReasonMessage(
  thresholdPercent: number,
): string {
  return `Precio por debajo del de catálogo: cuenta como descuento y supera el ${thresholdPercent} %. Indica el motivo del descuento.`;
}

export type EffectiveDiscountCheck =
  | { kind: 'ok' }
  | { kind: 'over-cap'; maxPercent: number; priceReduction: boolean }
  | {
      kind: 'reason-required';
      thresholdPercent: number;
      priceReduction: boolean;
    }
  | { kind: 'note-required' };

/**
 * La regla de DX-204 (`checkItemDiscount`: primero el tope, 403; luego el
 * motivo, 422) aplicada al descuento efectivo sobre el precio de referencia.
 * `priceReduction` dice si en el exceso entra una rebaja de precio (para que
 * el mensaje lo explique).
 */
export function checkEffectiveDiscount(
  policy: DiscountPolicyRules,
  role: ClinicRole,
  input: PricedItem & {
    reason: DiscountReason | null;
    reasonNote: string | null;
  },
): EffectiveDiscountCheck {
  const effective = effectiveDiscount(input);
  const check: ItemDiscountCheck = checkItemDiscount(policy, role, {
    price: effective.listPrice,
    discount: effective.total,
    reason: input.reason,
    reasonNote: input.reasonNote,
  });
  const priceReduction = effective.priceReduction > 0;
  switch (check.kind) {
    case 'over-cap':
    case 'reason-required':
      return { ...check, priceReduction };
    default:
      return check;
  }
}
