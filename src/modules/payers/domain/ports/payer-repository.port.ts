import { ClinicCountry, PayerType } from '@prisma/client';
import { Payer } from '../entities/payer.entity';

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreatePayerRepoInput {
  name: string;
  type: PayerType;
  country: ClinicCountry | null;
  active: boolean;
  createdById?: string;
}

export interface UpdatePayerRepoInput {
  name?: string;
  type?: PayerType;
  country?: ClinicCountry | null;
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
  create(input: CreatePayerRepoInput): Promise<Payer>;
  /** `null` si el pagador ya no existe (retirado entre la lectura y la escritura). */
  update(id: string, patch: UpdatePayerRepoInput): Promise<Payer | null>;
  /**
   * Retira el pagador (`deletedAt` y `active = false`) si ninguna cobertura
   * viva lo usa. Recuento y retiro van en UNA transacción con el pagador
   * bloqueado, así una cobertura que se crea a la vez o espera (y falla con
   * «Pagador no encontrado») o se cuenta aquí (`IN_USE`).
   */
  retire(id: string, updatedById?: string): Promise<RetirePayerResult>;
}
