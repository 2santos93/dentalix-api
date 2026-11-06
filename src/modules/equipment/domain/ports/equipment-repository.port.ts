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

export interface EquipmentRepository {
  /** Página de equipos bajo RLS, por nombre (y id para desempatar). */
  list(
    params: ListEquipmentRepoParams,
  ): Promise<{ rows: EquipmentRecord[]; total: number }>;
  /** Por id; uno de otra clínica da `null` (RLS). */
  findById(id: string): Promise<EquipmentRecord | null>;
  create(input: CreateEquipmentRepoInput): Promise<EquipmentRecord>;
  update(id: string, input: UpdateEquipmentRepoInput): Promise<EquipmentRecord>;
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
  addMaintenance(
    input: CreateMaintenanceRepoInput,
  ): Promise<EquipmentMaintenance>;
  /** Anula SOLO si sigue vivo: `null` si ya estaba anulado. */
  voidMaintenance(
    maintenanceId: string,
    input: { voidedById: string; voidReason: string },
  ): Promise<EquipmentMaintenance | null>;
}
