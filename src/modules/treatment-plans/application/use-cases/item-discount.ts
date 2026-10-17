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
  checkItemDiscount,
  reasonRequiredMessage,
  roleDiscountCapMessage,
  type DiscountPolicyRules,
} from '../../../discounts/domain/discount-policy';
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

/**
 * Valida un descuento contra la política para el rol de quien lo da y
 * devuelve lo que se guarda con él (DX-204). 403 «Tu rol permite hasta un X
 * %» si supera el tope; 422 si por encima del umbral falta el motivo (o la
 * nota con «Otro»). Sin descuento, el motivo, el autor y la hora se borran.
 */
export function decideDiscount(
  policy: DiscountPolicyRules,
  actor: DiscountActor,
  input: {
    price: number;
    discount: number;
    reason: DiscountReason | null;
    reasonNote: string | null;
  },
  at: Date,
): DiscountDecision {
  if (input.discount <= 0) return NO_DISCOUNT;
  const note = input.reasonNote?.trim() || null;
  if (note && !input.reason) {
    throw new UnprocessableEntityException(REASON_NOTE_WITHOUT_REASON_MESSAGE);
  }
  const check = checkItemDiscount(policy, actor.role, {
    price: input.price,
    discount: input.discount,
    reason: input.reason,
    reasonNote: note,
  });
  switch (check.kind) {
    case 'over-cap':
      throw new ForbiddenException(roleDiscountCapMessage(check.maxPercent));
    case 'reason-required':
      throw new UnprocessableEntityException(
        reasonRequiredMessage(check.thresholdPercent),
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
