import type {
  PrivacyPolicyContent,
  PrivacyPolicyVersion,
} from '../entities/privacy-policy.entity';

export const PRIVACY_POLICY_REPOSITORY = Symbol('PRIVACY_POLICY_REPOSITORY');

export interface PublishPolicyInput extends PrivacyPolicyContent {
  contentHash: string;
  publishedById: string;
}

export interface PrivacyPolicyRepository {
  /** Versiones publicadas de la clínica en contexto, de la mayor a la menor. */
  list(): Promise<PrivacyPolicyVersion[]>;

  /**
   * INSERTA la versión siguiente (`version = mayor + 1`). Nunca modifica una
   * versión existente: no hay método de edición a propósito.
   */
  publish(input: PublishPolicyInput): Promise<PrivacyPolicyVersion>;
}
