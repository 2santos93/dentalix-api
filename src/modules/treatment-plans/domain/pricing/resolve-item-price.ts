import { AgreementKind, PriceSource } from '@prisma/client';
import { currencyDecimals } from '../../../discounts/domain/discount-policy';
import { normalizeCategory } from '../../../agreements/domain/agreement-rules';

/** 400 cuando ni el convenio, ni la lista de la sede, ni el catálogo dan precio. */
export const PRICE_REQUIRED_MESSAGE =
  'Este procedimiento no tiene precio; indícalo.';
/** 400 cuando una prestación sin descuentos recibe uno (o un precio rebajado). */
export const NO_DISCOUNT_ALLOWED_MESSAGE =
  'Esta prestación no admite descuentos.';

/** Convenio vivo (no retirado) asignado al paciente, con la vigencia de la asignación. */
export interface PricingAgreement {
  id: string;
  name: string;
  kind: AgreementKind;
  /** % general (0–100), solo `PERCENT_DISCOUNT`. */
  percent: number | null;
  /** `{ "<categoría del catálogo>": <0–100> }`; gana sobre `percent`. */
  percentByCategory: Record<string, number> | null;
  priceListId: string | null;
  /** `null` = toda la clínica. */
  locationId: string | null;
  active: boolean;
  /** Días civiles `YYYY-MM-DD`; `null` = sin límite. */
  validFrom: string | null;
  validTo: string | null;
  assignmentValidFrom: string | null;
  assignmentValidTo: string | null;
}

/**
 * Lo que la resolución necesita, ya leído por el puerto `PricingSource`. Sin
 * E/S: la función es pura y se prueba con tablas.
 */
export interface PricingContext {
  catalogItem: {
    defaultPrice: number | null;
    category: string | null;
    allowDiscount: boolean;
  };
  /** Moneda del plan (ISO 4217). */
  planCurrency: string;
  /** Día civil de hoy en la zona de la sede que sella el ítem (R8). */
  today: string;
  /** Sede de escritura del request (`writeLocationId`). */
  locationId: string;
  agreement: PricingAgreement | null;
  /**
   * Precio del ítem en la lista del convenio (`PRICE_LIST`), si la lista sigue
   * viva y tiene precio para él; `null` si no.
   */
  agreementListPrice: {
    price: number;
    currency: string;
    active: boolean;
  } | null;
  /** Lista activa de la sede del request: su moneda y el precio del ítem (o `null`). */
  locationList: { price: number | null; currency: string } | null;
}

export interface ResolvedItemPrice {
  /** `defaultPrice` del catálogo en el momento (puede ser null). */
  basePrice: number | null;
  /** Precio de referencia resuelto (= `catalogPrice` del ítem, ruling R1). */
  price: number | null;
  source: PriceSource;
  agreementId: string | null;
  agreementName: string | null;
  allowDiscount: boolean;
}

/** ¿`today` cae dentro de [from, to]? Extremos incluidos; `null` = sin límite. */
function withinValidity(
  today: string,
  from: string | null,
  to: string | null,
): boolean {
  return (from === null || from <= today) && (to === null || to >= today);
}

/** ¿El convenio aplica hoy en la sede del request? (§3 paso 1) */
function agreementApplies(ctx: PricingContext): ctx is PricingContext & {
  agreement: PricingAgreement;
} {
  const a = ctx.agreement;
  return (
    a !== null &&
    a.active &&
    withinValidity(ctx.today, a.validFrom, a.validTo) &&
    withinValidity(ctx.today, a.assignmentValidFrom, a.assignmentValidTo) &&
    (a.locationId === null || a.locationId === ctx.locationId)
  );
}

/** % que aplica al ítem: el de su categoría (normalizada) si lo hay, si no el general. */
function percentFor(
  agreement: PricingAgreement,
  category: string | null,
): number | null {
  const key = category === null ? '' : normalizeCategory(category);
  if (key !== '' && agreement.percentByCategory) {
    for (const [name, percent] of Object.entries(agreement.percentByCategory)) {
      if (normalizeCategory(name) === key) return percent;
    }
  }
  return agreement.percent;
}

/**
 * `base × (1 − p/100)` redondeado a la unidad de la moneda del plan, la mitad
 * hacia arriba: la regla de `roundToCurrency` (R6), en enteros para que
 * 0,5 unidades nunca se pierdan por coma flotante. Nunca negativo ni por
 * encima de `base` (si la base trae decimales que la moneda no tiene, baja a
 * la unidad entera que no la supera).
 */
export function percentPrice(
  base: number,
  percent: number,
  currency: string,
): number {
  const p = Math.min(100, Math.max(0, percent));
  const baseCents = BigInt(Math.round(base * 100));
  const unit = 10n ** BigInt(2 - currencyDecimals(currency)); // en céntimos
  const scale = unit * 10000n;
  const numerator = baseCents * (10000n - BigInt(Math.round(p * 100)));
  let units = (numerator + scale / 2n) / scale;
  const whole = baseCents / unit;
  if (units > whole) units = whole;
  return Number(units * unit) / 100;
}

/**
 * Resolución del precio de referencia de un ítem nuevo (DX-105 §3):
 * 1. Convenio vivo del paciente, activo, vigente hoy (convenio Y asignación) y
 *    de la sede del request (o de toda la clínica):
 *    - `PERCENT_DISCOUNT`: solo si la prestación admite descuentos y tiene
 *      precio de catálogo → `AGREEMENT_PERCENT`; si no, sigue al paso 2.
 *    - `PRICE_LIST`: lista activa, en la moneda del plan y con precio para el
 *      ítem → `AGREEMENT_PRICE_LIST` (aunque no admita descuentos: es un precio
 *      pactado); si no, paso 2.
 * 2. Lista activa de la sede, en la moneda del plan, con precio → `PRICE_LIST`.
 * 3. `defaultPrice` del catálogo → `CATALOG` (puede ser null: el caso de uso
 *    pide entonces el precio).
 */
export function resolveItemPrice(ctx: PricingContext): ResolvedItemPrice {
  const { catalogItem } = ctx;
  const base = catalogItem.defaultPrice;
  const common = { basePrice: base, allowDiscount: catalogItem.allowDiscount };

  if (agreementApplies(ctx)) {
    const { agreement } = ctx;
    const fromAgreement = {
      agreementId: agreement.id,
      agreementName: agreement.name,
    };
    if (agreement.kind === AgreementKind.PERCENT_DISCOUNT) {
      const percent = percentFor(agreement, catalogItem.category);
      if (catalogItem.allowDiscount && base !== null && percent !== null) {
        return {
          ...common,
          ...fromAgreement,
          price: percentPrice(base, percent, ctx.planCurrency),
          source: PriceSource.AGREEMENT_PERCENT,
        };
      }
    } else {
      const listed = ctx.agreementListPrice;
      if (listed && listed.active && listed.currency === ctx.planCurrency) {
        return {
          ...common,
          ...fromAgreement,
          price: listed.price,
          source: PriceSource.AGREEMENT_PRICE_LIST,
        };
      }
    }
  }

  const sede = ctx.locationList;
  if (sede && sede.price !== null && sede.currency === ctx.planCurrency) {
    return {
      ...common,
      price: sede.price,
      source: PriceSource.PRICE_LIST,
      agreementId: null,
      agreementName: null,
    };
  }

  return {
    ...common,
    price: base,
    source: PriceSource.CATALOG,
    agreementId: null,
    agreementName: null,
  };
}
