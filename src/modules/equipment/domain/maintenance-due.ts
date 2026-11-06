import {
  addCivilDays,
  civilDateIn,
  civilDaysInclusive,
} from '../../../shared/time/civil-day';
import type {
  EquipmentCategory,
  EquipmentRecord,
} from './entities/equipment.entity';
import {
  EQUIPMENT_DUE_SOON_DAYS,
  maintenanceStatus,
  nextMaintenanceOn,
} from './equipment-rules';

/**
 * DX-543 · Avisos de mantenimiento en «Mi día»: los equipos activos cuyo
 * próximo preventivo está VENCIDO o vence en ≤30 días. Es la MISMA regla que
 * la lista de DX-542 (`nextMaintenanceOn` + `maintenanceStatus` en el día de
 * la sede del equipo); aquí solo se elige y se ordena.
 */
export const MAINTENANCE_DUE_STATUSES = ['OVERDUE', 'DUE_SOON'] as const;
export type MaintenanceDueStatus = (typeof MAINTENANCE_DUE_STATUSES)[number];

export interface MaintenanceDueItem {
  id: string;
  name: string;
  category: EquipmentCategory;
  locationId: string;
  locationName: string;
  chairId: string | null;
  chairName: string | null;
  /** Día civil de la sede en que toca (o tocaba) el preventivo. */
  nextMaintenanceOn: string;
  maintenanceStatus: MaintenanceDueStatus;
  /** Días de la sede hasta esa fecha: 0 = hoy, negativo = días de retraso. */
  daysUntilDue: number;
}

function isDue(status: string): status is MaintenanceDueStatus {
  return (MAINTENANCE_DUE_STATUSES as readonly string[]).includes(status);
}

/**
 * Los avisos, de lo más urgente a lo menos (la fecha más antigua primero;
 * a igual fecha, sede, nombre e id). Fuera: los dados de baja, los sin
 * programar, los al día y los de una sede sin zona (sin «hoy» no hay estado,
 * igual que en la lista).
 */
export function selectMaintenanceDue(
  records: readonly EquipmentRecord[],
  now: Date,
): MaintenanceDueItem[] {
  const items: MaintenanceDueItem[] = [];
  for (const record of records) {
    if (record.status !== 'ACTIVE' || !record.locationTimeZone) continue;
    const next = nextMaintenanceOn(record);
    if (next === null) continue;
    const today = civilDateIn(now, record.locationTimeZone);
    const status = maintenanceStatus(next, today);
    if (!isDue(status)) continue;
    items.push({
      id: record.id,
      name: record.name,
      category: record.category,
      locationId: record.locationId,
      locationName: record.locationName,
      chairId: record.chairId,
      chairName: record.chairName,
      nextMaintenanceOn: next,
      maintenanceStatus: status,
      daysUntilDue: civilDaysInclusive(today, next) - 1,
    });
  }
  return items.sort(
    (a, b) =>
      a.nextMaintenanceOn.localeCompare(b.nextMaintenanceOn) ||
      a.locationName.localeCompare(b.locationName, 'es') ||
      a.name.localeCompare(b.name, 'es') ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Tope de la preselección en la BD: el día UTC + 31. Ninguna zona va más de un
 * día por delante de UTC (UTC+14 como mucho), así que todo lo que vence en
 * ≤30 días de CUALQUIER sede cae antes; `selectMaintenanceDue` decide luego
 * con el día exacto de cada sede.
 */
export function maintenanceDueHorizon(now: Date): string {
  return addCivilDays(
    now.toISOString().slice(0, 10),
    EQUIPMENT_DUE_SOON_DAYS + 1,
  );
}
