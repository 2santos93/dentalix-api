import type { DiscountPolicyRules } from '../discount-policy';

/** La política guardada de la clínica en contexto (DX-204). */
export interface StoredDiscountPolicy extends DiscountPolicyRules {
  updatedAt: Date;
  updatedById: string | null;
}

export const DISCOUNT_POLICY_REPOSITORY = Symbol('DISCOUNT_POLICY_REPOSITORY');

export interface DiscountPolicyRepository {
  /** La fila de la clínica en contexto, o `null` si nunca se cambió. */
  find(): Promise<StoredDiscountPolicy | null>;
  /** Crea o reemplaza la fila de la clínica en contexto. */
  save(
    rules: DiscountPolicyRules,
    updatedById: string,
  ): Promise<StoredDiscountPolicy>;
}
