export const REFERENCE_LOOKUP = Symbol('REFERENCE_LOOKUP');

export interface ReferenceLookup {
  /** True iff a city with `cityId` exists AND its countryCode === `countryCode`. */
  cityBelongsToCountry(cityId: number, countryCode: string): Promise<boolean>;
}
