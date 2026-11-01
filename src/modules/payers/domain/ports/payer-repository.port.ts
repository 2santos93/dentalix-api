import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { Payer } from '../entities/payer.entity';
import type { PayerType } from '../payer-type';

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreatePayerRepoInput {
  name: string;
  type: PayerType;
  active: boolean;
  createdById?: string;
}

export interface UpdatePayerRepoInput {
  name?: string;
  type?: PayerType;
  active?: boolean;
  updatedById?: string;
}

export type RetirePayerResult = 'RETIRED' | 'IN_USE' | 'NOT_FOUND';

export const PAYER_REPOSITORY = Symbol('PAYER_REPOSITORY');

export interface PayerRepository {
  /** Pagadores vivos (no retirados) de la clínica en contexto, por nombre. */
  list(params: { includeInactive: boolean }): Promise<Payer[]>;
  /**
   * Pagador vivo por id, activo o no. Bajo RLS: uno de otra clínica (o
   * retirado) da `null`, igual que uno inexistente.
   */
  findById(id: string): Promise<Payer | null>;
  /**
   * Otro pagador vivo cuyo nombre normalizado (`payerNameKey`, igual que
   * `dx_search_normalize`) coincide. `excludeId` deja fuera al propio pagador
   * al renombrar.
   */
  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<Payer | null>;
  /**
   * DX-360: alta, cambio y retiro dejan su evento (PAYER) en la misma
   * transacción; un cambio que no cambia nada, ninguno.
   */
  create(
    input: CreatePayerRepoInput,
    audit: AuditRequestContext,
  ): Promise<Payer>;
  /** `null` si el pagador ya no existe (retirado entre la lectura y la escritura). */
  update(
    id: string,
    patch: UpdatePayerRepoInput,
    audit: AuditRequestContext,
  ): Promise<Payer | null>;
  /**
   * Retira el pagador (`deletedAt` y `active = false`) si ninguna cobertura
   * ni convenio vivo lo usa. Recuento y retiro van en UNA transacción con el pagador
   * bloqueado, así una cobertura que se crea a la vez o espera (y falla con
   * «Pagador no encontrado») o se cuenta aquí (`IN_USE`).
   */
  retire(id: string, audit: AuditRequestContext): Promise<RetirePayerResult>;
}
