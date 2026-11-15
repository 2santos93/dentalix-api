import type { OnboardingFacts } from '../onboarding-steps';

export const ONBOARDING_REPOSITORY = Symbol('ONBOARDING_REPOSITORY');

/** DX-020. Siempre la clínica del contexto, nunca una que llegue en la petición. */
export interface OnboardingRepository {
  /** Un booleano por paso y el descarte, en una sola consulta. */
  facts(): Promise<OnboardingFacts>;
  /** Marca la tarjeta como descartada (idempotente: conserva la primera fecha). */
  dismiss(): Promise<void>;
}
