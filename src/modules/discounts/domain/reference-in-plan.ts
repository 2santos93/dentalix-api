import type { ExchangeRateSource } from '@prisma/client';
import {
  discountReference,
  referenceCurrency,
  type ItemReference,
} from './effective-discount';
import { convertAtRate } from '../../../shared/money/rate-conversion';
import type { RoundingDigits } from '../../../shared/money/line-rounding';

/**
 * DX-513-bis: la tasa con la que se convirtió la referencia de un ítem al
 * escribirlo, como la congela un abono (DX-375): unidades por 1 USD de la
 * moneda de la referencia y de la del plan (8 decimales), la fuente y el día
 * civil de la tasa usada (con tasa manual puede ser anterior al de la sede,
 * DX-384).
 */
export interface FrozenReferenceRate {
  fromPerBase: number;
  toPerBase: number;
  source: ExchangeRateSource;
  /** AAAA-MM-DD. */
  rateDate: string;
}

/**
 * DX-513-bis: la foto de la referencia de un ítem en la moneda del plan.
 *
 * - `referenceCurrency`: moneda de `catalogPrice` al escribirlo (la del plan
 *   para las listas; la del catálogo para el resto; NULL si no se sabe).
 * - `referencePriceInPlan`: `catalogPrice` en la moneda del plan (convertido
 *   si su moneda es otra conocida; tal cual si es la del plan o no se sabe).
 * - `basePriceInPlan`: lo mismo para `basePrice`, que está en la moneda del
 *   catálogo. NULL si no se puede expresar sin otra tasa (referencia de una
 *   lista en la moneda del plan con el catálogo en otra: la rebaja de
 *   convenio no se resta entre monedas, H4 de DX-513).
 * - `referenceRate`: la tasa, solo si se convirtió.
 */
export interface ReferenceSnapshot {
  referenceCurrency: string | null;
  referencePriceInPlan: number | null;
  basePriceInPlan: number | null;
  referenceRate: FrozenReferenceRate | null;
}

export const NO_REFERENCE_SNAPSHOT: ReferenceSnapshot = {
  referenceCurrency: null,
  referencePriceInPlan: null,
  basePriceInPlan: null,
  referenceRate: null,
};

/** Lo que la foto necesita del ítem (o de su precio resuelto). */
export interface SnapshotItem extends ItemReference {
  basePrice: number | null;
  /** La foto, si ya la tiene (NULL en los ítems anteriores a DX-513-bis). */
  referencePriceInPlan: number | null;
}

/**
 * DX-513-bis §5.2: la referencia con la que se mide la rebaja de precio, en
 * la moneda del plan. Con foto, la foto (nunca se vuelve a pedir la tasa);
 * sin ella (ítem anterior, o ítem libre), la regla de DX-513 tal cual.
 */
export function referenceInPlan(
  item: ItemReference & Pick<SnapshotItem, 'referencePriceInPlan'>,
  planCurrency: string,
): number | null {
  if (item.referencePriceInPlan !== null) return item.referencePriceInPlan;
  return discountReference(item, planCurrency);
}

/**
 * La moneda de la que hay que pedir la tasa para congelar la referencia, o
 * `null` si no hace falta (ítem libre, referencia en la moneda del plan o en
 * una moneda que no se sabe).
 */
export function referenceRateCurrency(
  item: ItemReference,
  planCurrency: string,
): string | null {
  if (item.catalogPrice === null) return null;
  const currency = referenceCurrency(item, planCurrency);
  return currency !== null && currency !== planCurrency ? currency : null;
}

/**
 * ¿El ítem es anterior a la foto y la necesita para medir una rebaja?
 * (§5.8: referencia en otra moneda conocida y sin `referencePriceInPlan`.)
 */
export function needsReferenceSnapshot(
  item: SnapshotItem,
  planCurrency: string,
): boolean {
  return (
    item.referencePriceInPlan === null &&
    referenceRateCurrency(item, planCurrency) !== null
  );
}

/**
 * DX-513-bis §5.3: la foto de la referencia de un ítem en la moneda del plan,
 * con la tasa ya pedida (`rate`) si su moneda es otra conocida. Cada importe
 * se redondea UNA vez a los dígitos de redondeo de la moneda del plan.
 */
export function freezeReference(
  item: Omit<SnapshotItem, 'referencePriceInPlan'>,
  planCurrency: string,
  planDigits: RoundingDigits,
  rate: FrozenReferenceRate | null,
): ReferenceSnapshot {
  if (item.catalogPrice === null) return NO_REFERENCE_SNAPSHOT;
  const currency = referenceCurrency(item, planCurrency);
  if (currency === null || currency === planCurrency) {
    const baseInPlan =
      item.catalogCurrency === null || item.catalogCurrency === planCurrency;
    return {
      referenceCurrency: currency,
      referencePriceInPlan: item.catalogPrice,
      basePriceInPlan: baseInPlan ? item.basePrice : null,
      referenceRate: null,
    };
  }
  if (!rate) {
    throw new Error(
      `Referencia en ${currency} sin tasa a ${planCurrency}: hay que pedirla antes.`,
    );
  }
  const convert = (amount: number) => convertAtRate(amount, rate, planDigits);
  return {
    referenceCurrency: currency,
    referencePriceInPlan: convert(item.catalogPrice),
    // `basePrice` está en la moneda del catálogo, que aquí es `currency`.
    basePriceInPlan: item.basePrice === null ? null : convert(item.basePrice),
    referenceRate: rate,
  };
}
