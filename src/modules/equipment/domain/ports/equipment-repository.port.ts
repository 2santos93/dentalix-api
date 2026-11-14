import type {
  EquipmentCategory,
  EquipmentMaintenance,
  EquipmentRecord,
  EquipmentRiskClass,
  MaintenanceKind,
} from '../entities/equipment.entity';

export const EQUIPMENT_REPOSITORY = Symbol('EQUIPMENT_REPOSITORY');
/** Reloj del módulo: los tests fijan «hoy» de la sede. */
export const EQUIPMENT_CLOCK = Symbol('EQUIPMENT_CLOCK');
export type EquipmentClock = () => Date;

export type EquipmentStatusFilter = 'ACTIVE' | 'RETIRED' | 'ALL';

export interface ListEquipmentRepoParams {
  /** `undefined` = todas las sedes de la clínica (vista consolidada). */
  locationIds?: readonly string[];
  status: EquipmentStatusFilter;
  /** Contenido en nombre, marca, modelo o número de serie (sin mayúsculas). */
  query?: string;
  page: number;
  pageSize: number;
}

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreateEquipmentRepoInput {
  locationId: string;
  chairId: string | null;
  name: string;
  category: EquipmentCategory;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  sanitaryRegistration: string | null;
  riskClass: EquipmentRiskClass | null;
  acquiredOn: string | null;
  maintenanceIntervalMonths: number | null;
  notes: string | null;
  createdById: string;
}

/** Solo los campos que cambian; `null` borra un opcional. */
export interface UpdateEquipmentRepoInput {
  locationId?: string;
  chairId?: string | null;
  name?: string;
  category?: EquipmentCategory;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  sanitaryRegistration?: string | null;
  riskClass?: EquipmentRiskClass | null;
  acquiredOn?: string | null;
  maintenanceIntervalMonths?: number | null;
  notes?: string | null;
  updatedById: string;
}

export interface RetireEquipmentRepoInput {
  retiredOn: string;
  retiredReason: string;
  retiredById: string;
}

export interface CreateMaintenanceRepoInput {
  equipmentId: string;
  kind: MaintenanceKind;
  performedOn: string;
  technician: string | null;
  company: string | null;
  description: string;
  cost: number | null;
  currency: string | null;
  nextDueOn: string | null;
  createdById: string;
}

/**
 * DX-543: preselección de los avisos de «Mi día». Sin `tenantId`: lo pone el
 * contexto del request (y la RLS).
 */
export interface MaintenanceCandidatesRepoParams {
  /** `undefined` = todas las sedes de la clínica (vista consolidada). */
  locationIds?: readonly string[];
  /** Día civil: el próximo preventivo cae en él o antes. */
  dueOnOrBefore: string;
}

export interface EquipmentRepository {
  /** Página de equipos bajo RLS, por nombre (y id para desempatar). */
  list(
    params: ListEquipmentRepoParams,
  ): Promise<{ rows: EquipmentRecord[]; total: number }>;
  /**
   * DX-543: los equipos ACTIVOS de esas sedes cuyo próximo preventivo (la
   * misma regla que `nextMaintenanceOn`) cae en `dueOnOrBefore` o antes, con
   * lo mismo que la lista. Es un superconjunto: el estado exacto lo decide el
   * caso de uso con el día de cada sede.
   */
  listMaintenanceCandidates(
    params: MaintenanceCandidatesRepoParams,
  ): Promise<EquipmentRecord[]>;
  /** Por id; uno de otra clínica da `null` (RLS). */
  findById(id: string): Promise<EquipmentRecord | null>;
  create(input: CreateEquipmentRepoInput): Promise<EquipmentRecord>;
  /**
   * Edita SOLO si sigue activo (condicional en la BD): `null` si otra
   * petición lo dio de baja entre la lectura y la escritura.
   */
  update(
    id: string,
    input: UpdateEquipmentRepoInput,
  ): Promise<EquipmentRecord | null>;
  /**
   * Da de baja SOLO si sigue activo (la carrera de dos bajas la gana una):
   * `null` si ya estaba dado de baja.
   */
  retire(
    id: string,
    input: RetireEquipmentRepoInput,
  ): Promise<EquipmentRecord | null>;
  /** Hoja de vida: en orden cronológico (fecha y luego alta). */
  listMaintenances(equipmentId: string): Promise<EquipmentMaintenance[]>;
  findMaintenance(
    equipmentId: string,
    maintenanceId: string,
  ): Promise<EquipmentMaintenance | null>;
  /**
   * Registra SOLO si el equipo sigue activo (lo bloquea en la transacción, así
   * una baja simultánea espera o gana): `null` si ya está dado de baja.
   */
  addMaintenance(
    input: CreateMaintenanceRepoInput,
  ): Promise<EquipmentMaintenance | null>;
  /** Anula SOLO si sigue vivo: `null` si ya estaba anulado. */
  voidMaintenance(
    maintenanceId: string,
    input: { voidedById: string; voidReason: string },
  ): Promise<EquipmentMaintenance | null>;
}
