import { ClinicRole } from '@prisma/client';
import {
  DEFAULT_DISCOUNT_POLICY,
  type DiscountPolicyRules,
} from '../../../../discounts/domain/discount-policy';
import type { GetDiscountPolicyUseCase } from '../../../../discounts/application/use-cases/discount-policy.use-cases';
import type { DiscountActor } from '../item-discount';

/** Política fija para las specs (la de por defecto si no se da otra). */
export function testDiscountPolicy(
  rules: DiscountPolicyRules = DEFAULT_DISCOUNT_POLICY,
): GetDiscountPolicyUseCase {
  return {
    execute: () =>
      Promise.resolve({
        ...rules,
        isDefault: rules === DEFAULT_DISCOUNT_POLICY,
        updatedAt: null,
        updatedById: null,
      }),
  } as unknown as GetDiscountPolicyUseCase;
}

export const DISCOUNT_NOW = new Date('2026-10-17T15:00:00.000Z');
export const FIXED_CLOCK = () => DISCOUNT_NOW;

export const ADMIN_ACTOR: DiscountActor = {
  userId: 'admin-1',
  role: ClinicRole.ADMIN,
};
export const DENTIST_ACTOR: DiscountActor = {
  userId: 'dentist-1',
  role: ClinicRole.DENTIST,
};
export const ASSISTANT_ACTOR: DiscountActor = {
  userId: 'assistant-1',
  role: ClinicRole.ASSISTANT,
};
