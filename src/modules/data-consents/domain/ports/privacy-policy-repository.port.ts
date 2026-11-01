import type {
  PrivacyPolicyContent,
  PrivacyPolicyVersion,
} from '../entities/privacy-policy.entity';

import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

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
   * versión existente: no hay método de edición a propósito. DX-360: deja su
   * evento (CREATE PRIVACY_POLICY) en la misma transacción.
   */
  publish(
    input: PublishPolicyInput,
    audit: AuditRequestContext,
  ): Promise<PrivacyPolicyVersion>;
}
