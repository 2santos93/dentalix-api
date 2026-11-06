import {
  addCivilDays,
  civilDateIn,
  civilDaysInclusive,
} from '../../../shared/time/civil-day';
import type {
  RadiologyLicenseCategory,
  RadiologyRecordKind,
  RadiologyRecordRecord,
} from './entities/radiology-record.entity';
import { RADIOLOGY_DUE_SOON_DAYS, radiologyStatus } from './radiology-rules';

/**
 * DX-544 · Avisos del expediente de rayos X en «Mi día»: los documentos vivos
 * VENCIDOS o que vencen en ≤90 días en el día de su sede, sin los ya
 * renovados. Es la MISMA regla que la lista (`radiologyStatus`); aquí solo se
 * elige y se ordena.
 */
export const RADIOLOGY_DUE_STATUSES = ['OVERDUE', 'DUE_SOON'] as const;
export type RadiologyDueStatus = (typeof RADIOLOGY_DUE_STATUSES)[number];

export interface RadiologyDueItem {
  id: string;
  kind: RadiologyRecordKind;
  category: RadiologyLicenseCategory | null;
  reference: string | null;
  issuer: string;
  locationId: string;
  locationName: string;
  equipmentId: string | null;
  equipmentName: string | null;
  /** Día civil de la sede en que vence (o venció). */
  expiresOn: string;
  status: RadiologyDueStatus;
  /** Días de la sede hasta el vencimiento: 0 = hoy, negativo = días vencido. */
  daysUntilExpiry: number;
}

function isDue(status: string): status is RadiologyDueStatus {
  return (RADIOLOGY_DUE_STATUSES as readonly string[]).includes(status);
}

/**
 * De lo más urgente a lo menos: el vencimiento más antiguo primero; a igual
 * fecha, sede, tipo (licencia antes) e id. Fuera: los anulados, los
 * renovados, los al día y los de una sede sin zona (sin «hoy» no hay estado).
 */
export function selectRadiologyDue(
  records: readonly RadiologyRecordRecord[],
  now: Date,
): RadiologyDueItem[] {
  const items: RadiologyDueItem[] = [];
  for (const record of records) {
    if (record.voidedAt !== null || !record.locationTimeZone) continue;
    const today = civilDateIn(now, record.locationTimeZone);
    const status = radiologyStatus(record.expiresOn, today, record.renewed);
    if (!isDue(status)) continue;
    items.push({
      id: record.id,
      kind: record.kind,
      category: record.category,
      reference: record.reference,
      issuer: record.issuer,
      locationId: record.locationId,
      locationName: record.locationName,
      equipmentId: record.equipmentId,
      equipmentName: record.equipmentName,
      expiresOn: record.expiresOn,
      status,
      daysUntilExpiry: civilDaysInclusive(today, record.expiresOn) - 1,
    });
  }
  return items.sort(
    (a, b) =>
      a.expiresOn.localeCompare(b.expiresOn) ||
      a.locationName.localeCompare(b.locationName, 'es') ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Tope de la preselección en la BD: el día UTC + 91. Ninguna zona va más de un
 * día por delante de UTC, así que todo lo que vence en ≤90 días de CUALQUIER
 * sede cae antes; `selectRadiologyDue` decide luego con el día de cada sede.
 */
export function radiologyDueHorizon(now: Date): string {
  return addCivilDays(
    now.toISOString().slice(0, 10),
    RADIOLOGY_DUE_SOON_DAYS + 1,
  );
}
