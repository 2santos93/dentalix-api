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
  update(id: string, patch: UpdatePayerRepoInput): Promise<Payer>;
  /** Borrado lógico: `deletedAt` y `active = false`. */
  softDelete(id: string, updatedById?: string): Promise<void>;
  /** Coberturas vivas de pacientes que usan este pagador. */
  countLiveCoverages(payerId: string): Promise<number>;
}
