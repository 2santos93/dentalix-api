import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_DISCOUNT_POLICY,
  type DiscountPolicyRules,
} from '../../domain/discount-policy';
import {
  DISCOUNT_POLICY_REPOSITORY,
  type DiscountPolicyRepository,
} from '../../domain/ports/discount-policy-repository.port';

/** La política vigente de la clínica; `isDefault` si nunca se cambió. */
export interface DiscountPolicyView extends DiscountPolicyRules {
  isDefault: boolean;
  updatedAt: Date | null;
  updatedById: string | null;
}

/**
 * Lee la política de descuentos de la clínica en contexto (DX-204). La usan la
 * pantalla de Ajustes, el formulario del ítem (para avisar antes) y, sobre
 * todo, los casos de uso de los ítems del plan, que la aplican en el servidor.
 */
@Injectable()
export class GetDiscountPolicyUseCase {
  constructor(
    @Inject(DISCOUNT_POLICY_REPOSITORY)
    private readonly repo: DiscountPolicyRepository,
  ) {}

  async execute(): Promise<DiscountPolicyView> {
    const stored = await this.repo.find();
    if (!stored) {
      return {
        maxPercentByRole: { ...DEFAULT_DISCOUNT_POLICY.maxPercentByRole },
        reasonRequiredAbovePercent:
          DEFAULT_DISCOUNT_POLICY.reasonRequiredAbovePercent,
        isDefault: true,
        updatedAt: null,
        updatedById: null,
      };
    }
    return { ...stored, isDefault: false };
  }
}

/** Cambia la política (solo ADMIN, lo exige el controlador). */
@Injectable()
export class UpdateDiscountPolicyUseCase {
  constructor(
    @Inject(DISCOUNT_POLICY_REPOSITORY)
    private readonly repo: DiscountPolicyRepository,
  ) {}

  async execute(
    rules: DiscountPolicyRules,
    updatedById: string,
  ): Promise<DiscountPolicyView> {
    const saved = await this.repo.save(rules, updatedById);
    return { ...saved, isDefault: false };
  }
}
