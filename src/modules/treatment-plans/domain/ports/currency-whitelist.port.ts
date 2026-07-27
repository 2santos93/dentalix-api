export const CURRENCY_WHITELIST = Symbol('CURRENCY_WHITELIST');

// `has` checks against the seeded `currencies` table (global, not
// tenant-scoped) — used by treatment-plan create/update AND
// RecordPaymentUseCase (payments module) to reject unknown ISO 4217 codes
// with a 400, same rationale as `ReferenceLookup.cityBelongsToCountry`
// validating patient location (patients module).
export interface CurrencyWhitelist {
  has(code: string): Promise<boolean>;
}
