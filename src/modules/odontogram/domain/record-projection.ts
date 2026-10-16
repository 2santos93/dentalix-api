import { ToothRecord } from './entities/tooth-record.entity';

/**
 * Anulación vista desde el registro anulado (DX-120): quién, cuándo y por qué.
 * La anulación es otra fila de tooth_records; aquí solo se resume.
 */
export interface ToothRecordVoid {
  id: string;
  reason: string;
  performedById: string | null;
  recordedAt: Date;
}

export interface ToothRecordWithVoid extends ToothRecord {
  void: ToothRecordVoid | null;
}

/**
 * Registros que pinta la carta: ni las anulaciones ni lo anulado. Con
 * `cutoff` (corte EXCLUSIVO, el primer instante del día siguiente a `asOf`)
 * solo cuenta lo registrado antes, también las anulaciones: lo que se anuló
 * después de esa fecha sigue en la carta de esa fecha. Conserva el orden.
 */
export function activeRecords(
  records: readonly ToothRecord[],
  cutoff?: Date,
): ToothRecord[] {
  const visible = cutoff
    ? records.filter((r) => r.recordedAt.getTime() < cutoff.getTime())
    : [...records];
  const voided = new Set(
    visible
      .map((r) => r.voidsRecordId)
      .filter((id): id is string => id !== null),
  );
  return visible.filter((r) => r.voidsRecordId === null && !voided.has(r.id));
}

/**
 * Historial de un diente: cada registro con su anulación (si la tiene), sin
 * listar la anulación como una fila más. Conserva el orden de entrada.
 */
export function attachVoids(
  records: readonly ToothRecord[],
): ToothRecordWithVoid[] {
  const voids = new Map<string, ToothRecordVoid>();
  for (const r of records) {
    if (r.voidsRecordId !== null) {
      voids.set(r.voidsRecordId, {
        id: r.id,
        reason: r.voidReason ?? '',
        performedById: r.performedById,
        recordedAt: r.recordedAt,
      });
    }
  }
  return records
    .filter((r) => r.voidsRecordId === null)
    .map((r) => ({ ...r, void: voids.get(r.id) ?? null }));
}
