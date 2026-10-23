import type {
  CancellationPolicyInput,
  CancellationPolicyVersion,
} from '../cancellation-policy';

export const CANCELLATION_POLICY_REPOSITORY = Symbol(
  'CANCELLATION_POLICY_REPOSITORY',
);

// Sin `tenantId` en ningún método: sale del contexto del request (RLS), como
// en el resto de repositorios. Una sede de otra clínica es una sede que no
// existe (null).
export interface CancellationPolicyRepository {
  /**
   * Versiones de la sede viva, de la más nueva a la más antigua; `null` si la
   * sede no existe en esta clínica (o está retirada).
   */
  listVersions(locationId: string): Promise<CancellationPolicyVersion[] | null>;

  /**
   * Guarda la versión siguiente de la política de la sede (la anterior no se
   * toca), con la sede bloqueada para que dos guardados a la vez no tomen el
   * mismo número. `null` si la sede no existe en esta clínica.
   */
  createVersion(
    locationId: string,
    input: CancellationPolicyInput,
    createdById: string,
  ): Promise<CancellationPolicyVersion | null>;

  /** ¿Existe la moneda en el catálogo (`currencies`)? */
  currencyExists(code: string): Promise<boolean>;
}
