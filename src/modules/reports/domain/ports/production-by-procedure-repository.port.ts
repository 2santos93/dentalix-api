import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type { ProcedureSums } from '../production-by-procedure';

/** Una sede que quien consulta puede ver (DX-089), viva (activa o no). */
export interface ProductionLocation {
  id: string;
  name: string;
  isActive: boolean;
}

/** Un profesional que puede figurar como quien realizó (DX-050). */
export interface ProductionProfessional {
  userId: string;
  fullName: string;
}

/**
 * A qué se acota la producción: sedes de realización (`performedLocationId`),
 * y, opcionales, quién la realizó y la categoría del catálogo.
 */
export interface ProductionScope {
  locationIds: readonly string[];
  professionalId?: string;
  category?: string;
}

/** Realizados «Sin atribuir» (sin fecha o sin sede, DX-305), por moneda. */
export interface UnattributedSums {
  currency: string;
  count: number;
  gross: number;
  discounts: number;
}

export interface ProductionItemRow {
  id: string;
  completedAt: Date;
  /** null = paciente eliminado: no se nombra ni se enlaza. */
  patientId: string | null;
  patientName: string | null;
  professionalId: string | null;
  professionalName: string | null;
  locationId: string;
  locationName: string;
  /** Zona de la sede donde se realizó: la fecha se pinta con ella. */
  timeZone: string;
  toothNumber: string;
  currency: string;
  price: number;
  discount: number;
}

export const PRODUCTION_BY_PROCEDURE_REPOSITORY = Symbol(
  'PRODUCTION_BY_PROCEDURE_REPOSITORY',
);

export interface ProductionByProcedureRepository {
  /** Sedes vivas de la clínica que el usuario ve, en orden de creación. */
  listLocations(allowed: AllowedLocations): Promise<ProductionLocation[]>;
  /** ¿Es una sede viva de la clínica en contexto? */
  locationInClinic(locationId: string): Promise<boolean>;
  /**
   * Quien figura como autor de algún realizado vivo en esas sedes (también
   * ex-miembros), por nombre.
   */
  listProfessionals(
    locationIds: readonly string[],
  ): Promise<ProductionProfessional[]>;
  /** Categorías de los procedimientos del catálogo de la clínica. */
  listCategories(): Promise<string[]>;
  /**
   * Σ por procedimiento y moneda de los ítems DONE vivos de planes vivos,
   * realizados en `period` (días civiles en la zona de la sede de
   * realización) en una de `scope.locationIds`. Una sola consulta agregada.
   */
  aggregate(
    period: CivilPeriod,
    scope: ProductionScope,
  ): Promise<ProcedureSums[]>;
  /**
   * Σ por moneda de los DONE vivos sin `completedAt` o sin
   * `performedLocationId` («Sin atribuir»): los que tienen sede, si es una de
   * `scope.locationIds`; los que no, solo con `includeWithoutLocation`.
   */
  unattributed(
    scope: ProductionScope,
    includeWithoutLocation: boolean,
  ): Promise<UnattributedSums[]>;
  /** Los ítems de un procedimiento (y moneda) del agregado, paginados. */
  listItems(
    period: CivilPeriod,
    scope: ProductionScope & { catalogItemId: string; currency?: string },
    page: { skip: number; take: number },
  ): Promise<{ items: ProductionItemRow[]; total: number }>;
}
