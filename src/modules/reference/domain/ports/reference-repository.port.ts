import { Currency } from '../entities/currency.entity';
import { Country } from '../entities/country.entity';
import { City } from '../entities/city.entity';

export const REFERENCE_REPOSITORY = Symbol('REFERENCE_REPOSITORY');

export interface ReferenceRepository {
  listCurrencies(): Promise<Currency[]>;
  listCountries(): Promise<Country[]>;
  searchCities(
    countryCode: string,
    q: string | undefined,
    limit: number,
  ): Promise<City[]>;
}
