import type { ClinicCountry } from '@prisma/client';

export interface Location {
  id: string;
  tenantId: string;
  name: string;
  address: string | null;
  /** País de la sede (DX-013): decide los campos legales de la receta. */
  country: ClinicCountry;
  /** DX-319: nº de registro sanitario (texto libre) o null. */
  healthRegistrationNumber: string | null;
  /** DX-319: si el nº sale en los documentos de la sede. */
  showHealthRegistrationNumber: boolean;
  /** DX-222: teléfono de la sede para las indicaciones postoperatorias, o null. */
  phone: string | null;
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
  phone?: string;
}

export interface UpdateLocationRepoInput {
  name?: string;
  address?: string;
  country?: ClinicCountry;
  /** DX-319: ya recortado; null lo quita. */
  healthRegistrationNumber?: string | null;
  showHealthRegistrationNumber?: boolean;
  /** DX-222: ya recortado; null lo quita. */
  phone?: string | null;
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
