import { ExchangeRateSnapshot } from '../entities/exchange-rate-snapshot.entity';

export const EXCHANGE_RATE_REPOSITORY = Symbol('EXCHANGE_RATE_REPOSITORY');

/**
 * Repository for the `exchange_rate_snapshots` global reference table.
 *
 * Deliberately NOT tenant-scoped: rates are global market data (base USD),
 * not a tenant's domain data, so implementations must NOT use
 * `runWithTenant`/`TenantContextService` and must NOT filter by tenant — see
 * the multi-tenancy rule's documented technical exception (cache/queue-like
 * reference data).
 */
export interface ExchangeRateRepository {
  /** All currency snapshots stored for `date` (empty array = cache miss). */
  findByDate(date: string): Promise<ExchangeRateSnapshot[]>;

  /**
   * Idempotent upsert of one row per (date, currency) pair in `rates`.
   * Re-running with the same date/rates updates the existing rows (rate +
   * fetchedAt) instead of duplicating them, per the `@@unique([date,
   * currency])` constraint.
   */
  upsertMany(date: string, rates: Record<string, number>): Promise<void>;
}
