import type { Chair } from '../entities/chair.entity';

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreateChairRepoInput {
  locationId: string;
  name: string;
  sortOrder: number;
  /** Ya validado por el caso de uso (miembro activo que atiende en la sede). */
  defaultProviderId: string | null;
  createdById: string;
}

export interface UpdateChairRepoInput {
  name?: string;
  sortOrder?: number;
  /** `null` lo quita. */
  defaultProviderId?: string | null;
  active?: boolean;
  updatedById: string;
}

export const CHAIR_REPOSITORY = Symbol('CHAIR_REPOSITORY');

export interface ChairRepository {
  /** Sillones de la sede (bajo RLS), por `sortOrder` y luego por nombre. */
  listByLocation(params: {
    locationId: string;
    includeInactive: boolean;
  }): Promise<Chair[]>;
  /** Por id, activo o no. Uno de otra clínica da `null` (RLS). */
  findById(id: string): Promise<Chair | null>;
  /** Varios por id (los que existan en esta clínica). */
  findByIds(ids: readonly string[]): Promise<Chair[]>;
  /** 409 en español si el nombre ya existe en la sede (único de la BD). */
  create(input: CreateChairRepoInput): Promise<Chair>;
  update(id: string, input: UpdateChairRepoInput): Promise<Chair>;
  /**
   * Fija el orden de los sillones de la sede (0, 1, 2… en el orden dado), en
   * una transacción. El caso de uso ya comprobó que son todos los de la sede.
   */
  reorder(
    locationId: string,
    chairIds: readonly string[],
    updatedById: string,
  ): Promise<Chair[]>;
}
