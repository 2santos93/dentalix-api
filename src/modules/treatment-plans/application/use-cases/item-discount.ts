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
  effectiveDiscount,
  effectiveDiscountRises,
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
  type PricedItem,
} from '../../../discounts/domain/effective-discount';
import type { TreatmentPlanWithItems } from '../../domain/entities/treatment-plan.entity';
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

/** Quién da (o cambia) un descuento: el usuario y el rol del token (DX-204). */
export interface DiscountActor {
  userId: string;
  role: ClinicRole;
}

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
