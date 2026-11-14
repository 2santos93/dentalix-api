/**
 * Equipo biomédico de una sede (DX-542): el inventario de dotación con su hoja
 * de vida. Pertenece a una sede (obligatoria) y, si se quiere, a un sillón de
 * esa misma sede. No se borra: se da de baja con fecha y motivo.
 */
export const EQUIPMENT_CATEGORIES = [
  'AUTOCLAVE',
  'DENTAL_UNIT',
  'XRAY',
  'COMPRESSOR',
  'CURING_LIGHT',
  'ULTRASONIC_SCALER',
  'OTHER',
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

/** Clasificación por riesgo del dispositivo (texto neutro, sin norma de un país). */
export const EQUIPMENT_RISK_CLASSES = ['I', 'IIA', 'IIB', 'III'] as const;
export type EquipmentRiskClass = (typeof EQUIPMENT_RISK_CLASSES)[number];

export const EQUIPMENT_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const MAINTENANCE_KINDS = [
  'PREVENTIVE',
  'CORRECTIVE',
  'CALIBRATION',
] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

/** Estado del programa de mantenimiento en el día de la sede. */
export type MaintenanceStatus =
  'OVERDUE' | 'DUE_SOON' | 'UP_TO_DATE' | 'UNSCHEDULED';

export interface Equipment {
  id: string;
  tenantId: string;
  locationId: string;
  chairId: string | null;
  name: string;
  category: EquipmentCategory;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  /** Texto libre: el registro del producto ante la autoridad que toque. */
  sanitaryRegistration: string | null;
  riskClass: EquipmentRiskClass | null;
  /** Día civil (YYYY-MM-DD). */
  acquiredOn: string | null;
  /** Periodicidad del mantenimiento preventivo (1–120 meses). */
  maintenanceIntervalMonths: number | null;
  status: EquipmentStatus;
  retiredOn: string | null;
  retiredReason: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Un mantenimiento (preventivo, correctivo o calibración). Inalterable: se
 * corrige anulándolo con motivo y registrando otro.
 */
export interface EquipmentMaintenance {
  id: string;
  equipmentId: string;
  kind: MaintenanceKind;
  performedOn: string;
  technician: string | null;
  company: string | null;
  description: string;
  cost: number | null;
  currency: string | null;
  /** Próximo mantenimiento que dejó fijado (explícito o por la periodicidad). */
  nextDueOn: string | null;
  createdById: string;
  createdByName: string | null;
  createdAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidReason: string | null;
}

/** El último preventivo vivo del equipo: lo que decide el próximo. */
export interface LastPreventive {
  performedOn: string;
  nextDueOn: string | null;
}

/** Fila del equipo con lo que la lista y la hoja de vida necesitan al lado. */
export interface EquipmentRecord extends Equipment {
  locationName: string;
  /** Zona de la sede: su «hoy» decide vencido/próximo. */
  locationTimeZone: string | null;
  chairName: string | null;
  lastPreventive: LastPreventive | null;
  /** Fecha del último mantenimiento vivo de cualquier tipo. */
  lastMaintenanceOn: string | null;
}
