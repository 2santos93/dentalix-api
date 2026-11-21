import type { BcvRateSnapshot } from '../bcv-rate';

export const BCV_RATE_REPOSITORY = Symbol('BCV_RATE_REPOSITORY');

/**
 * DX-585: `bcv_rate_snapshots`, una tasa por «Fecha Valor». Tabla GLOBAL
 * (sin clínica ni RLS), como `exchange_rate_snapshots`: las implementaciones
 * NO usan `runWithTenant` ni filtran por clínica.
 */
export interface BcvRateRepository {
  /**
   * La tasa que rige el día `date`: la de fecha valor <= `date` más reciente,
   * siempre que no sea anterior a `oldest` (`null` si no hay ninguna así).
   */
  inForce(date: string, oldest: string): Promise<BcvRateSnapshot | null>;
  /** La guardada con fecha valor <= `valueDate` más reciente (la de comparar). */
  latestUpTo(valueDate: string): Promise<BcvRateSnapshot | null>;
  /** La de fecha valor más reciente que se guardó, sea del día que sea. */
  latest(): Promise<BcvRateSnapshot | null>;
  /** Alta o corrección de la tasa de esa fecha valor. */
  upsert(snapshot: BcvRateSnapshot): Promise<void>;
}
