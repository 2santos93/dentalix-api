/**
 * Domain shape of a persisted daily exchange-rate snapshot. Deliberately NOT
 * the raw Prisma model: the repository must `mapToEntity` before returning
 * across the port boundary (same convention as DentalCatalogItem/Patient).
 * `rate` is a plain `number` here (Prisma returns `Decimal`).
 *
 * NOTE: this is global reference/market data, NOT tenant-scoped domain data
 * — there is deliberately no `tenantId` field (see multi-tenancy rule: this
 * table is the documented technical exception, like cache/queue rows).
 */
export interface ExchangeRateSnapshot {
  id: string;
  /** YYYY-MM-DD, the historical day this rate applies to. */
  date: string;
  /** ISO 4217 currency code, e.g. "COP", "EUR". */
  currency: string;
  /** Units of `currency` per 1 USD. */
  rate: number;
  fetchedAt: Date;
}
