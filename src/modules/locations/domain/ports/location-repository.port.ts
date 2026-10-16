import type { ClinicCountry } from '@prisma/client';

export interface Location {
  id: string;
  tenantId: string;
  name: string;
  address: string | null;
  /** País de la sede (DX-013): decide los campos legales de la receta. */
  country: ClinicCountry;
  isActive: boolean;
  /**
   * Zona IANA de la sede (DX-097): la de su horario, o la de su país si no
   * tiene. Con ella la web decide qué es «hoy» en la caja y el dashboard.
   */
  timeZone: string;
  createdAt: Date;
  updatedAt: Date;
}

// NOTA: sin `tenantId` — el tenant sale del contexto del request, nunca del
// cliente (misma convención que CreatePaymentRepoInput).
export interface CreateLocationRepoInput {
  name: string;
  address?: string;
  country?: ClinicCountry;
}

export interface UpdateLocationRepoInput {
  name?: string;
  address?: string;
  country?: ClinicCountry;
  isActive?: boolean;
}

export const LOCATION_REPOSITORY = Symbol('LOCATION_REPOSITORY');

export interface LocationRepository {
  create(input: CreateLocationRepoInput): Promise<Location>;
  /** Sedes no borradas del tenant, ordenadas por fecha de creación. */
  list(): Promise<Location[]>;
  findById(id: string): Promise<Location | null>;
  update(id: string, patch: UpdateLocationRepoInput): Promise<Location | null>;
  /** Cuántas sedes ACTIVAS quedan — para no dejar la clínica sin ninguna. */
  countActive(): Promise<number>;
  /** ¿Hay operaciones (citas/pagos/inventario) atadas a esta sede? */
  hasOperations(id: string): Promise<boolean>;
}
