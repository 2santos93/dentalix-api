import { AgreementKind } from '@prisma/client';
import { Agreement } from '../entities/agreement.entity';

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreateAgreementRepoInput {
  name: string;
  payerId: string;
  kind: AgreementKind;
  percent: number | null;
  percentByCategory: Record<string, number> | null;
  priceListId: string | null;
  locationId: string | null;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
  createdById?: string;
}

/**
 * `undefined` = no se toca; `null` = vacía la columna. El caso de uso ya
 * resolvió el `kind` final: al cambiarlo, los campos del otro `kind` llegan en
 * `null`.
 */
export interface UpdateAgreementRepoInput {
  name?: string;
  payerId?: string;
  kind?: AgreementKind;
  percent?: number | null;
  percentByCategory?: Record<string, number> | null;
  priceListId?: string | null;
  locationId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  active?: boolean;
  updatedById?: string;
}

export type RetireAgreementResult = 'RETIRED' | 'IN_USE' | 'NOT_FOUND';

export const AGREEMENT_REPOSITORY = Symbol('AGREEMENT_REPOSITORY');

export interface AgreementRepository {
  /** Convenios vivos (no retirados) de la clínica en contexto, por nombre. */
  list(params: { includeInactive: boolean }): Promise<Agreement[]>;
  /**
   * Convenio vivo por id, activo o no. Bajo RLS: uno de otra clínica (o
   * retirado) da `null`, igual que uno inexistente.
   */
  findById(id: string): Promise<Agreement | null>;
  /**
   * Convenio no retirado (activo o no) con lo que necesita la resolución de
   * precios del plan: `kind`, porcentajes, lista, sede, vigencia y estado.
   * Mismo alcance que `findById`; es el contrato que consumen otros módulos.
   */
  findLiveById(id: string): Promise<Agreement | null>;
  /**
   * Otro convenio vivo cuyo nombre normalizado (`agreementNameKey`, igual que
   * `dx_search_normalize`) coincide. `excludeId` deja fuera al propio convenio
   * al renombrar.
   */
  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<Agreement | null>;
  /**
   * Con `payerId` o `priceListId` en juego, los relee `FOR SHARE` dentro de la
   * transacción (el retiro del pagador o de la lista los toma `FOR UPDATE` y
   * cuenta convenios vivos), y exige que sigan vivos y activos.
   */
  create(input: CreateAgreementRepoInput): Promise<Agreement>;
  /** `null` si el convenio ya no existe (retirado entre la lectura y la escritura). */
  update(
    id: string,
    patch: UpdateAgreementRepoInput,
  ): Promise<Agreement | null>;
  /**
   * Retira el convenio (`deletedAt` y `active = false`) si ningún paciente
   * vivo lo tiene asignado. Recuento y retiro van en UNA transacción con el
   * convenio bloqueado `FOR UPDATE`.
   */
  retire(id: string, updatedById?: string): Promise<RetireAgreementResult>;
}
