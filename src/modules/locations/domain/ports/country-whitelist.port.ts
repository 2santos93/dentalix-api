export const COUNTRY_WHITELIST = Symbol('COUNTRY_WHITELIST');

// `has` checks against the seeded `countries` table (global, not
// tenant-scoped): the country of a location is any ISO 3166-1 alpha-2 code
// in that list, and none of them decides a rule.
export interface CountryWhitelist {
  has(code: string): Promise<boolean>;
}
