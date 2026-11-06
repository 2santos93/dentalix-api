import type {
  RadiologyRecord,
  RadiologyRecordRecord,
  RadiologyStatus,
} from '../domain/entities/radiology-record.entity';

/** Lo que la API devuelve de un documento (lista, detalle, alta, edición, anulación). */
export interface RadiologyRecordView extends RadiologyRecord {
  locationName: string;
  equipmentName: string | null;
  officerMemberName: string | null;
  /** En el día de la sede; `null` si está anulado o la sede no tiene zona. */
  status: RadiologyStatus | null;
}

export function radiologyRecordView(
  record: RadiologyRecordRecord,
  status: RadiologyStatus | null,
): RadiologyRecordView {
  const { locationTimeZone: _zone, renewed: _renewed, ...rest } = record;
  return { ...rest, status };
}
