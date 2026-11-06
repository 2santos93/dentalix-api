import type {
  Equipment,
  EquipmentMaintenance,
  EquipmentRecord,
  MaintenanceStatus,
} from '../domain/entities/equipment.entity';

/** Lo que la API devuelve de un equipo (lista, alta, edición, baja). */
export interface EquipmentView extends Equipment {
  locationName: string;
  chairName: string | null;
  lastMaintenanceOn: string | null;
  /** Próximo preventivo (día civil de la sede) o `null` = sin programar. */
  nextMaintenanceOn: string | null;
  /** `null` si está dado de baja (no tiene programa). */
  maintenanceStatus: MaintenanceStatus | null;
}

/** La hoja de vida: el equipo y sus mantenimientos en orden cronológico. */
export interface EquipmentDetailView extends EquipmentView {
  maintenances: EquipmentMaintenance[];
}

export function equipmentView(
  record: EquipmentRecord,
  nextMaintenanceOn: string | null,
  maintenanceStatus: MaintenanceStatus | null,
): EquipmentView {
  const {
    locationTimeZone: _zone,
    lastPreventive: _lastPreventive,
    ...rest
  } = record;
  return { ...rest, nextMaintenanceOn, maintenanceStatus };
}
