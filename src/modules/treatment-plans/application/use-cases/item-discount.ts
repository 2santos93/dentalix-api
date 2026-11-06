import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ClinicRole,
  DiscountReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  REASON_NOTE_REQUIRED_MESSAGE,
  reasonRequiredMessage,
  roleDiscountCapMessage,
  type DiscountPolicyRules,
} from '../../../discounts/domain/discount-policy';
import {
  checkEffectiveDiscount,
  discountReference,
  effectiveDiscount,
  effectiveDiscountRises,
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
  type ItemReference,
  type PricedItem,
} from '../../../discounts/domain/effective-discount';
import type { TreatmentPlanWithItems } from '../../domain/entities/treatment-plan.entity';
import { NO_DISCOUNT_ALLOWED_MESSAGE } from '../../domain/pricing/resolve-item-price';
import type { DiscountStamp } from '../../domain/ports/treatment-plan-repository.port';

/** 0 ≤ descuento ≤ precio (DX-012). La base lo repite con un CHECK. */
export function assertDiscountWithinPrice(
  price: number,
  discount: number,
): void {
  if (discount > price) {
    throw new BadRequestException(
      'El descuento no puede ser mayor que el precio del ítem.',
    );
  }
}

/**
 * DX-105: una prestación con `allowDiscount=false` no admite descuento
 * discrecional: ni `discount > 0` ni un precio por debajo de la referencia
 * (`catalogPrice`). 400 con el mensaje en español.
 */
export function assertDiscountAllowed(
  allowDiscount: boolean,
  item: PricedItem,
): void {
  if (!allowDiscount && effectiveDiscount(item).total > 0) {
    throw new BadRequestException(NO_DISCOUNT_ALLOWED_MESSAGE);
  }
}

/** Quién da (o cambia) un descuento: el usuario y el rol del token (DX-204). */
export interface DiscountActor {
  userId: string;
  role: ClinicRole;
}

/**
 * DX-513 (revisión H1): con la moneda nueva, un ítem con el precio por debajo
 * del catálogo pasaría a contar como descuento, dentro del tope y con motivo,
 * pero sin firma de quién lo dio.
 */
export const CURRENCY_CHANGE_UNSIGNED_DISCOUNT_MESSAGE =
  'Con la nueva moneda, un ítem con el precio por debajo del de catálogo pasaría a contar como descuento sin firmar. Sube su precio al de catálogo antes de cambiar la moneda y, si hace falta, vuelve a rebajarlo después.';
/**
 * DX-513 (revisión H1): con la moneda nueva, una rebaja frente al catálogo
 * firmada en la moneda actual dejaría de verse en el informe de descuentos.
 */
export const CURRENCY_CHANGE_HIDES_DISCOUNT_MESSAGE =
  'Hay ítems con el precio por debajo del de catálogo que cuentan como descuento en la moneda actual: con la nueva dejarían de verse en el informe de descuentos. Sube su precio al de catálogo antes de cambiar la moneda.';

export const ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE =
  'El presupuesto ya está aceptado: sus descuentos no se pueden cambiar.';
export const REASON_NOTE_WITHOUT_REASON_MESSAGE =
  'Elige el motivo del descuento antes de escribir la nota.';

/**
 * Un presupuesto aceptado no se vuelve a descontar (DX-204): ni el firmado
 * (DX-012, que además congela todo el ítem) ni el aceptado sin firma. El
 * cerrado ya lo bloquea `assertPlanOpenForItems`.
 */
export function assertPlanDiscountable(
  plan: Pick<TreatmentPlanWithItems, 'status' | 'acceptance'>,
): void {
  if (plan.acceptance || plan.status === TreatmentPlanStatus.ACCEPTED) {
    throw new ConflictException(ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE);
  }
}

export interface DiscountDecision {
  discountReason: DiscountReason | null;
  discountReasonNote: string | null;
  discountStamp: DiscountStamp | null;
}

/** Lo que se guarda en un ítem sin descuento. */
export const NO_DISCOUNT: DiscountDecision = {
  discountReason: null,
  discountReasonNote: null,
  discountStamp: null,
};

/** El precio y el descuento de un ítem, con su motivo (DX-204, SEC-041). */
export interface ItemDiscountInput extends PricedItem {
  reason: DiscountReason | null;
  reasonNote: string | null;
}

/**
 * Valida el descuento EFECTIVO de un ítem (rebaja frente al precio de
 * catálogo + `discount`, SEC-041) contra la política para el rol de quien lo
 * da y devuelve lo que se guarda con él (DX-204). 403 «Tu rol permite hasta un
 * X %» si supera el tope; 422 si por encima del umbral falta el motivo (o la
 * nota con «Otro»); si en el exceso entra una rebaja de precio, el mensaje lo
 * dice. Sin descuento efectivo, el motivo, el autor y la hora se borran.
 */
export function decideDiscount(
  policy: DiscountPolicyRules,
  actor: DiscountActor,
  input: ItemDiscountInput,
  at: Date,
): DiscountDecision {
  if (effectiveDiscount(input).total <= 0) return NO_DISCOUNT;
  const note = input.reasonNote?.trim() || null;
  if (note && !input.reason) {
    throw new UnprocessableEntityException(REASON_NOTE_WITHOUT_REASON_MESSAGE);
  }
  const check = checkEffectiveDiscount(policy, actor.role, {
    ...input,
    reasonNote: note,
  });
  switch (check.kind) {
    case 'over-cap':
      throw new ForbiddenException(
        check.priceReduction
          ? priceBelowCatalogCapMessage(check.maxPercent)
          : roleDiscountCapMessage(check.maxPercent),
      );
    case 'reason-required':
      throw new UnprocessableEntityException(
        check.priceReduction
          ? priceBelowCatalogReasonMessage(check.thresholdPercent)
          : reasonRequiredMessage(check.thresholdPercent),
      );
    case 'note-required':
      throw new UnprocessableEntityException(REASON_NOTE_REQUIRED_MESSAGE);
    case 'ok':
      return {
        discountReason: input.reason,
        discountReasonNote: note,
        discountStamp: { byId: actor.userId, at },
      };
  }
}

/**
 * Un cambio sobre el descuento de un ítem que ya existe (edición o «Descuento
 * %»), SEC-041:
 *
 * - Se valida y se firma a nombre de quien lo hace si da MÁS descuento: sube
 *   el % efectivo (p. ej. bajar el precio), pone un `discount` nuevo distinto
 *   de 0 (como en DX-204) o cambia el motivo o su nota.
 * - Si el ítem se queda sin descuento efectivo, se borran motivo y firma.
 * - Si no (subir el precio, quitar el `discount` de un ítem cuyo precio sigue
 *   rebajado), es libre y conserva el motivo y la firma de quien lo dio:
 *   devuelve `undefined`.
 */
export function decideDiscountChange(
  policy: DiscountPolicyRules,
  actor: DiscountActor,
  before: PricedItem,
  after: ItemDiscountInput,
  changes: { discountSet: boolean; reasonChanged: boolean },
  at: Date,
): DiscountDecision | undefined {
  if (effectiveDiscount(after).total <= 0) return NO_DISCOUNT;
  const givesMore =
    changes.reasonChanged ||
    (changes.discountSet && after.discount > 0) ||
    effectiveDiscountRises(before, after);
  return givesMore ? decideDiscount(policy, actor, after, at) : undefined;
}

/**
 * ¿El cambio toca el descuento efectivo del ítem? Si lo toca, un plan
 * aceptado lo rechaza (`assertPlanDiscountable`).
 */
export function touchesDiscount(
  before: PricedItem,
  after: PricedItem,
  changes: { discountSet: boolean; reasonChanged: boolean },
): boolean {
  return (
    changes.discountSet ||
    changes.reasonChanged ||
    (after.price !== before.price &&
      (effectiveDiscount(before).total > 0 ||
        effectiveDiscount(after).total > 0))
  );
}

/** Un ítem vivo del plan, con lo que decide si su rebaja cuenta (DX-513). */
export interface CurrencyChangeItem extends ItemReference {
  price: number;
  discount: number;
  discountReason: DiscountReason | null;
  discountReasonNote: string | null;
  discountById: string | null;
}

/**
 * DX-513 (revisión H1): la moneda del plan decide si la rebaja frente al
 * catálogo cuenta como descuento (`discountReference`). Al cambiarla, cada
 * ítem vivo se vuelve a medir con la moneda nueva, dentro de la transacción
 * del cambio (el plan bloqueado); cualquier error para todo el cambio:
 *
 * - Si su rebaja APARECE o crece: la regla del alta con el rol de quien
 *   cambia la moneda (403 por encima del tope, 422 sin motivo) y, aunque la
 *   pasara, 409: esa rebaja nunca se firmó.
 * - Si DESAPARECE o baja: 409. El informe de descuentos se calcula con la
 *   moneda actual del plan, así que una rebaja que cuenta hoy (firmada)
 *   dejaría de verse; se bloquea en vez de esconderla.
 *
 * Los ítems no cambian: o el plan cambia de moneda sin tocar ningún
 * descuento, o no cambia.
 */
export function assertCurrencyChangeKeepsDiscounts(
  policy: DiscountPolicyRules,
  actor: DiscountActor,
  items: readonly CurrencyChangeItem[],
  from: string,
  to: string,
  at: Date,
): void {
  for (const item of items) {
    const measured = (currency: string): PricedItem => ({
      catalogPrice: discountReference(item, currency),
      price: item.price,
      discount: item.discount,
    });
    const before = effectiveDiscount(measured(from)).priceReduction;
    const after = effectiveDiscount(measured(to)).priceReduction;
    if (after > before) {
      decideDiscount(
        policy,
        actor,
        {
          ...measured(to),
          reason: item.discountReason,
          reasonNote: item.discountReasonNote,
        },
        at,
      );
      throw new ConflictException(CURRENCY_CHANGE_UNSIGNED_DISCOUNT_MESSAGE);
    }
    if (after < before) {
      throw new ConflictException(CURRENCY_CHANGE_HIDES_DISCOUNT_MESSAGE);
    }
  }
}
