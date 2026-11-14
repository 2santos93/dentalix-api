import { createHash } from 'node:crypto';
import {
  ConflictException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import {
  DiscountReason,
  PriceSource,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import type { DiscountPolicyRules } from '../../discounts/domain/discount-policy';
import { effectiveDiscountRises } from '../../discounts/domain/effective-discount';
import {
  referenceInPlan,
  type FrozenReferenceRate,
  type ReferenceSnapshot,
} from '../../discounts/domain/reference-in-plan';
import { amountText } from '../../../shared/money/money';
import {
  linesTotal,
  scaleAmount,
  type RoundingDigits,
} from '../../../shared/money/line-rounding';
import { toRateColumn } from '../../../shared/money/rate-conversion';
import type { TreatmentPlanItem } from '../domain/entities/treatment-plan-item.entity';
import type { TreatmentPlanWithItems } from '../domain/entities/treatment-plan.entity';
import type { PlanFacts } from '../domain/ports/treatment-plan-repository.port';
import type { ResolvedItemPrice } from '../domain/pricing/resolve-item-price';
import {
  PLAN_STATUS_LABELS,
  isPlanClosed,
} from '../domain/plan-status-machine';
import {
  storedQuoteValidity,
  type QuoteValidity,
} from '../domain/quote-validity';
import { FEE_ITEM_LOCKED_MESSAGE } from '../../cancellation-fees/domain/cancellation-fee';
import {
  decideDiscountChange,
  type DiscountActor,
  type DiscountDecision,
} from './use-cases/item-discount';

// ---------------------------------------------------------------------------
// DX-379 (porción B): «Actualizar precios» (recotizar). Una sola función pura,
// `computeRepricing`, para la vista previa y para aplicar (D-8): aplicar la
// vuelve a calcular con el plan bloqueado y exige la misma huella
// (`previewHash`) que devolvió la vista previa.
// ---------------------------------------------------------------------------

export const REPRICE_STALE_CODE = 'REPRICE_PREVIEW_STALE';
export const REPRICE_STALE_MESSAGE =
  'Los precios vigentes cambiaron desde la vista previa: revísala de nuevo.';
export const REPRICE_NOTHING_CODE = 'REPRICE_NOTHING_TO_APPLY';
export const REPRICE_NOTHING_MESSAGE =
  'Ningún ítem propuesto del plan tiene un precio vigente que aplicar.';
/**
 * DX-379 (C): al aceptar un presupuesto vencido actualizando los precios,
 * TODOS los ítems propuestos tienen que tener precio vigente: si no, la
 * validez no se renueva y el presupuesto seguiría vencido.
 */
export const REPRICE_INCOMPLETE_CODE = 'REPRICE_INCOMPLETE';
export const REPRICE_INCOMPLETE_MESSAGE =
  'Algún ítem propuesto no tiene precio vigente (o falta la tasa de cambio de hoy): no se pueden actualizar todos los precios. Corrígelo o acepta con los precios originales indicando el motivo.';
export const REPRICE_SIGNED_MESSAGE =
  'El presupuesto ya está aceptado y firmado: sus precios no se actualizan.';
export const REPRICE_PAYMENTS_MESSAGE =
  'El plan tiene abonos registrados: sus precios ya no se actualizan. Anula los abonos antes de actualizarlos.';
export const REPRICE_PAYMENT_PLAN_MESSAGE =
  'El plan tiene un plan de cuotas activo: cancélalo antes de actualizar los precios.';
export const REPRICE_CREDIT_MESSAGE =
  'El plan tiene saldo a favor traspasado o devuelto: sus precios ya no se actualizan.';
export const REPRICE_ITEM_NOT_PROPOSED_MESSAGE =
  'Solo se actualizan los precios de los ítems propuestos: alguno de los elegidos ya está aceptado, realizado o descartado.';
export const REPRICE_VALIDITY_NOT_RENEWED_MESSAGE =
  'Quedan ítems con precios anteriores: la validez no se renueva.';
export const REPRICE_ITEM_NOT_FOUND_MESSAGE =
  'Algún ítem no existe o no es de este plan de tratamiento.';

export function repricePlanStatusMessage(status: TreatmentPlanStatus): string {
  return `El plan está «${PLAN_STATUS_LABELS[status]}»: sus precios ya no se actualizan.`;
}

/** Por qué un ítem no se recotiza (se lista, no se toca). */
export const REPRICING_SKIP_REASONS = [
  /** No está propuesto (aceptado, realizado, descartado). */
  'NOT_PROPOSED',
  /** SEC-050: es el cargo vigente por inasistencia de una cita. */
  'CANCELLATION_FEE',
  /** D-10: sin precio vigente (o 0), o el procedimiento ya no existe. */
  'NO_CURRENT_PRICE',
  /** El precio vigente está en otra moneda y no hay tasa de hoy. */
  'NO_RATE',
] as const;
export type RepricingSkipReason = (typeof REPRICING_SKIP_REASONS)[number];

/**
 * El precio vigente de un procedimiento (el que daría hoy el alta), ya en la
 * moneda del plan, o por qué no lo hay.
 */
export type RepricingReference =
  | {
      kind: 'priced';
      resolved: Pick<
        ResolvedItemPrice,
        | 'price'
        | 'basePrice'
        | 'source'
        | 'agreementId'
        | 'agreementName'
        | 'allowDiscount'
      >;
      /** DX-502: moneda de `basePrice`; null sin precio de catálogo. */
      catalogCurrency: string | null;
      /** Sede con la que se resolvió (la de escritura del request). */
      pricingLocationId: string;
      /** La foto en la moneda del plan, con la tasa de hoy si hizo falta. */
      reference: ReferenceSnapshot;
    }
  | { kind: 'no-price' }
  | { kind: 'no-rate'; currency: string };

/** El precio de un ítem, tal como queda en su fila (antes o después). */
export interface ItemPriceState {
  catalogPrice: number | null;
  basePrice: number | null;
  catalogCurrency: string | null;
  priceSource: PriceSource | null;
  agreementId: string | null;
  agreementName: string | null;
  pricingLocationId: string | null;
  reference: ReferenceSnapshot;
  price: number;
  discount: number;
  discountReason: DiscountReason | null;
  discountReasonNote: string | null;
  discountById: string | null;
  /** ISO; null sin descuento. */
  discountAt: string | null;
  /**
   * Sede del descuento. `null` también cuando lo firma quien recotiza: la pone
   * el repositorio (la de escritura), como en el resto de descuentos.
   */
  discountLocationId: string | null;
}

export interface RepricingLine {
  itemId: string;
  catalogItemId: string;
  toothNumber: string;
  before: ItemPriceState;
  after: ItemPriceState;
  /** ¿Cambia algo del precio o de su foto? */
  changed: boolean;
  /**
   * Qué se hace con el motivo y la firma del descuento (SEC-041):
   * `undefined` = se conservan; `NO_DISCOUNT` = se borran; otra = se firma a
   * nombre de quien recotiza (el % efectivo subió por redondeo).
   */
  discountDecision?: DiscountDecision;
}

export interface RepricingSkip {
  itemId: string;
  catalogItemId: string;
  toothNumber: string;
  reason: RepricingSkipReason;
  /** Con NO_RATE, la moneda sin tasa; null en el resto. */
  currency: string | null;
}

/** La tasa usada (de la moneda del catálogo a la del plan), si hizo falta. */
export interface RepricingRate extends FrozenReferenceRate {
  currency: string;
}

export interface Repricing {
  planId: string;
  currency: string;
  lines: RepricingLine[];
  skipped: RepricingSkip[];
  rate: RepricingRate | null;
  previousValidity: QuoteValidity | null;
  /**
   * I-1: ¿se renueva la validez? Solo si se recotizan TODOS los ítems
   * propuestos vivos del plan (sin selección parcial ni saltados por falta de
   * precio o tasa). Si no, se conserva la anterior.
   */
  validityRenewed: boolean;
  /** Sin renovar, por qué (texto para la pantalla); null si se renueva. */
  validityNote: string | null;
  /** La validez con la que queda el plan: la nueva o la que ya tenía. */
  validity: QuoteValidity | null;
  /** Total del plan (todas sus líneas vivas) antes y después. */
  totals: { before: number; after: number };
  previewHash: string;
}

export interface RepricingInput {
  plan: Pick<
    TreatmentPlanWithItems,
    'id' | 'currency' | 'items' | 'quoteIssuedOn' | 'quoteValidUntil'
  >;
  /** Ítems pedidos; sin ellos, todos los propuestos. */
  itemIds?: readonly string[];
  /** Precio vigente por procedimiento (`catalogItemId`). */
  references: ReadonlyMap<string, RepricingReference>;
  /** Dígitos de redondeo por línea de la moneda del plan. */
  digits: RoundingDigits;
  policy: DiscountPolicyRules;
  actor: DiscountActor;
  at: Date;
  /**
   * La validez nueva si se renueva: emitido hoy (sede del plan) + días del
   * ajuste.
   */
  validity: QuoteValidity;
}

/**
 * D-11: un plan aceptado (con o sin firma) o cerrado no se recotiza, ni uno
 * con abonos vivos, plan de cuotas activo o saldo a favor en asientos (los
 * importes cobrados o financiados se calcularon con los precios de ahora).
 */
export function assertPlanRepriceable(
  plan: Pick<TreatmentPlanWithItems, 'status' | 'acceptance'>,
  facts: PlanFacts,
): void {
  if (plan.acceptance) throw new ConflictException(REPRICE_SIGNED_MESSAGE);
  if (
    plan.status === TreatmentPlanStatus.ACCEPTED ||
    isPlanClosed(plan.status)
  ) {
    throw new ConflictException(repricePlanStatusMessage(plan.status));
  }
  if (facts.hasCreditEntries) {
    throw new ConflictException(REPRICE_CREDIT_MESSAGE);
  }
  if (facts.hasLivePayments) {
    throw new ConflictException(REPRICE_PAYMENTS_MESSAGE);
  }
  if (facts.hasActivePaymentPlan) {
    throw new ConflictException(REPRICE_PAYMENT_PLAN_MESSAGE);
  }
}

/** 409 con su `code` (la web distingue sin leer el texto). */
export function repricingConflict(
  code: string,
  message: string,
): HttpException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

/** Los procedimientos cuyo precio vigente hace falta (ítems candidatos). */
export function repricingCatalogItemIds(
  plan: Pick<TreatmentPlanWithItems, 'items'>,
  itemIds?: readonly string[],
): string[] {
  const { candidates } = selectItems(plan.items, itemIds);
  return [...new Set(candidates.map((item) => item.catalogItemId))];
}

function selectItems(
  items: readonly TreatmentPlanItem[],
  itemIds?: readonly string[],
): { candidates: TreatmentPlanItem[]; skipped: RepricingSkip[] } {
  const skipOf = (
    item: TreatmentPlanItem,
    reason: RepricingSkipReason,
  ): RepricingSkip => ({
    itemId: item.id,
    catalogItemId: item.catalogItemId,
    toothNumber: item.toothNumber,
    reason,
    currency: null,
  });
  if (itemIds && itemIds.length > 0) {
    // M-6: los UUID se comparan en minúsculas (como los guarda la base).
    const wanted = [...new Set(itemIds.map((id) => id.toLowerCase()))];
    const byId = new Map(items.map((item) => [item.id, item]));
    const picked = wanted.map((id) => byId.get(id));
    if (picked.some((item) => item === undefined)) {
      throw new NotFoundException(REPRICE_ITEM_NOT_FOUND_MESSAGE);
    }
    const chosen = picked as TreatmentPlanItem[];
    if (chosen.some((item) => item.cancellationFeeAppointmentId)) {
      throw new ConflictException(FEE_ITEM_LOCKED_MESSAGE);
    }
    if (
      chosen.some((item) => item.status !== TreatmentPlanItemStatus.PROPOSED)
    ) {
      throw new ConflictException(REPRICE_ITEM_NOT_PROPOSED_MESSAGE);
    }
    return { candidates: chosen, skipped: [] };
  }
  const candidates: TreatmentPlanItem[] = [];
  const skipped: RepricingSkip[] = [];
  for (const item of items) {
    if (item.cancellationFeeAppointmentId) {
      skipped.push(skipOf(item, 'CANCELLATION_FEE'));
    } else if (item.status !== TreatmentPlanItemStatus.PROPOSED) {
      skipped.push(skipOf(item, 'NOT_PROPOSED'));
    } else {
      candidates.push(item);
    }
  }
  return { candidates, skipped };
}

function stateOf(item: TreatmentPlanItem): ItemPriceState {
  return {
    catalogPrice: item.catalogPrice,
    basePrice: item.basePrice,
    catalogCurrency: item.catalogCurrency,
    priceSource: item.priceSource,
    agreementId: item.agreementId,
    agreementName: item.agreementName,
    pricingLocationId: item.pricingLocationId,
    reference: {
      referenceCurrency: item.referenceCurrency,
      referencePriceInPlan: item.referencePriceInPlan,
      basePriceInPlan: item.basePriceInPlan,
      referenceRate: item.referenceRate ?? item.baseRate,
    },
    price: item.price,
    discount: item.discount,
    discountReason: item.discountReason,
    discountReasonNote: item.discountReasonNote,
    discountById: item.discountById,
    discountAt: item.discountAt ? item.discountAt.toISOString() : null,
    discountLocationId: item.discountLocationId,
  };
}

/**
 * D-4 (proporcional): el precio nuevo guarda la proporción precio /
 * referencia congelada (así también la rebaja manual que SEC-041 cuenta como
 * descuento) y el descuento nuevo la proporción descuento / precio, cada uno
 * redondeado UNA vez a la moneda del plan. Sin referencia previa (> 0), o si
 * la prestación no admite descuentos, el precio nuevo es el vigente.
 */
function newAmounts(
  item: TreatmentPlanItem,
  oldReference: number | null,
  newReference: number,
  allowDiscount: boolean,
  digits: RoundingDigits,
): { price: number; discount: number; floorDiscount: number } {
  // M-4: con una rebaja manual (precio < referencia) el precio sube a la
  // unidad (nunca baja): la rebaja no crece y el % efectivo no sube por el
  // redondeo. Sin rebaja, la mitad hacia arriba (la regla de línea).
  const price =
    !allowDiscount || oldReference === null || oldReference <= 0
      ? newReference
      : scaleAmount(
          newReference,
          item.price,
          oldReference,
          digits,
          item.price < oldReference ? 'ceil' : 'half-up',
        );
  if (item.discount <= 0 || item.price <= 0) {
    return { price, discount: 0, floorDiscount: 0 };
  }
  const at = (mode: 'half-up' | 'floor') =>
    Math.min(
      price,
      scaleAmount(price, item.discount, item.price, digits, mode),
    );
  return { price, discount: at('half-up'), floorDiscount: at('floor') };
}

function priceFieldsDiffer(a: ItemPriceState, b: ItemPriceState): boolean {
  return canonicalState(a) !== canonicalState(b);
}

/**
 * Recotiza los ítems del plan con el precio vigente (D-4, D-10, D-11). Pura:
 * sin E/S ni reloj (todo llega en `input`). Lanza 404 si un ítem pedido no es
 * del plan, 409 si un ítem pedido no está propuesto o es un cargo por
 * inasistencia y, como el resto de descuentos (SEC-041), 403/422 si el
 * redondeo sube el % efectivo de un ítem por encima del tope o del umbral de
 * quien recotiza. El estado del plan lo mira `assertPlanRepriceable`.
 */
export function computeRepricing(input: RepricingInput): Repricing {
  const { plan, digits } = input;
  const { candidates, skipped } = selectItems(plan.items, input.itemIds);
  const lines: RepricingLine[] = [];

  for (const item of candidates) {
    const ref = input.references.get(item.catalogItemId);
    const skip = (reason: RepricingSkipReason, currency: string | null) =>
      skipped.push({
        itemId: item.id,
        catalogItemId: item.catalogItemId,
        toothNumber: item.toothNumber,
        reason,
        currency,
      });
    if (!ref || ref.kind === 'no-price') {
      skip('NO_CURRENT_PRICE', null);
      continue;
    }
    if (ref.kind === 'no-rate') {
      skip('NO_RATE', ref.currency);
      continue;
    }
    const newReference = ref.reference.referencePriceInPlan;
    if (newReference === null || newReference <= 0) {
      skip('NO_CURRENT_PRICE', null);
      continue;
    }

    const oldReference = referenceInPlan(item, plan.currency);
    const amounts = newAmounts(
      item,
      oldReference,
      newReference,
      ref.resolved.allowDiscount,
      digits,
    );
    const before = {
      catalogPrice: oldReference,
      price: item.price,
      discount: item.discount,
    };
    // Si el redondeo del descuento sube el % efectivo, baja a la unidad que
    // no lo sube (como «Descuento %»): solo el del precio puede subirlo.
    let discount = amounts.discount;
    const after = (d: number) => ({
      catalogPrice: newReference,
      price: amounts.price,
      discount: d,
    });
    if (effectiveDiscountRises(before, after(discount))) {
      discount = amounts.floorDiscount;
    }
    const decision = decideDiscountChange(
      input.policy,
      input.actor,
      before,
      {
        ...after(discount),
        reason: item.discountReason,
        reasonNote: item.discountReasonNote,
      },
      { discountSet: false, reasonChanged: false },
      input.at,
    );

    const previous = stateOf(item);
    const stamp =
      decision === undefined
        ? {
            discountReason: previous.discountReason,
            discountReasonNote: previous.discountReasonNote,
            discountById: previous.discountById,
            discountAt: previous.discountAt,
            discountLocationId: previous.discountLocationId,
          }
        : {
            discountReason: decision.discountReason,
            discountReasonNote: decision.discountReasonNote,
            discountById: decision.discountStamp?.byId ?? null,
            discountAt: decision.discountStamp?.at.toISOString() ?? null,
            discountLocationId: null,
          };
    const next: ItemPriceState = {
      catalogPrice: ref.resolved.price,
      basePrice: ref.resolved.basePrice,
      catalogCurrency: ref.catalogCurrency,
      priceSource: ref.resolved.source,
      agreementId: ref.resolved.agreementId,
      agreementName: ref.resolved.agreementName,
      pricingLocationId: ref.pricingLocationId,
      reference: ref.reference,
      price: amounts.price,
      discount,
      ...stamp,
    };
    lines.push({
      itemId: item.id,
      catalogItemId: item.catalogItemId,
      toothNumber: item.toothNumber,
      before: previous,
      after: next,
      changed: priceFieldsDiffer(previous, next),
      ...(decision === undefined ? {} : { discountDecision: decision }),
    });
  }

  lines.sort((a, b) => a.itemId.localeCompare(b.itemId));
  skipped.sort((a, b) => a.itemId.localeCompare(b.itemId));

  const replaced = new Map(lines.map((line) => [line.itemId, line.after]));
  const totals = {
    before: linesTotal(plan.items),
    after: linesTotal(plan.items.map((item) => replaced.get(item.id) ?? item)),
  };
  const rateLine = lines.find((line) => line.after.reference.referenceRate);
  const rate: RepricingRate | null =
    rateLine && rateLine.after.reference.referenceRate
      ? {
          currency: rateLine.after.catalogCurrency ?? plan.currency,
          ...rateLine.after.reference.referenceRate,
        }
      : null;
  // I-1: la validez solo se renueva si TODOS los propuestos vivos (sin los
  // cargos por inasistencia) se recotizan.
  const repriced = new Set(lines.map((line) => line.itemId));
  const proposed = plan.items.filter(
    (item) =>
      item.status === TreatmentPlanItemStatus.PROPOSED &&
      !item.cancellationFeeAppointmentId,
  );
  const validityRenewed =
    proposed.length > 0 && proposed.every((item) => repriced.has(item.id));
  const previousValidity = storedQuoteValidity(plan);
  const repricing = {
    planId: plan.id,
    currency: plan.currency,
    lines,
    skipped,
    rate,
    previousValidity,
    validityRenewed,
    validityNote: validityRenewed ? null : REPRICE_VALIDITY_NOT_RENEWED_MESSAGE,
    validity: validityRenewed ? input.validity : previousValidity,
    totals,
  };
  return { ...repricing, previewHash: repricingHash(repricing) };
}

const amount = (value: number | null): string | null =>
  value === null ? null : amountText(value, 2);

function canonicalRate(rate: FrozenReferenceRate | null): unknown {
  return rate
    ? [
        String(toRateColumn(rate.fromPerBase)),
        String(toRateColumn(rate.toPerBase)),
        rate.source,
        rate.rateDate,
      ]
    : null;
}

/**
 * Lo que la huella mira del precio de un ítem: importes y su foto, nunca el
 * motivo ni la firma del descuento (la firma lleva la hora de la petición).
 */
function canonicalState(state: ItemPriceState): string {
  return JSON.stringify([
    amount(state.catalogPrice),
    amount(state.basePrice),
    state.catalogCurrency,
    state.priceSource,
    state.agreementId,
    state.agreementName,
    state.pricingLocationId,
    state.reference.referenceCurrency,
    amount(state.reference.referencePriceInPlan),
    amount(state.reference.basePriceInPlan),
    canonicalRate(state.reference.referenceRate),
    amount(state.price),
    amount(state.discount),
  ]);
}

/**
 * D-8: SHA-256 (hex) canónico de lo que se va a aplicar: cada línea (antes y
 * después), los saltados, la tasa usada y la validez nueva. Si algo de eso
 * cambia entre la vista previa y aplicar, la huella no coincide.
 */
export function repricingHash(
  repricing: Omit<Repricing, 'previewHash'>,
): string {
  const canonical = JSON.stringify({
    v: 1,
    planId: repricing.planId.toLowerCase(),
    currency: repricing.currency,
    lines: repricing.lines.map((line) => [
      line.itemId.toLowerCase(),
      canonicalState(line.before),
      canonicalState(line.after),
    ]),
    skipped: repricing.skipped.map((skip) => [
      skip.itemId.toLowerCase(),
      skip.reason,
      skip.currency,
    ]),
    rate: repricing.rate
      ? [repricing.rate.currency, canonicalRate(repricing.rate)]
      : null,
    validity: [
      repricing.validityRenewed,
      repricing.validity
        ? [repricing.validity.issuedOn, repricing.validity.validUntil]
        : null,
    ],
  });
  return createHash('sha256').update(canonical).digest('hex');
}
