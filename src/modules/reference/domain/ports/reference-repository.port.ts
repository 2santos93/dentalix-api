import { Currency } from '../entities/currency.entity';
import { Country } from '../entities/country.entity';
import { City } from '../entities/city.entity';
import { Icd10Code } from '../entities/icd10-code.entity';

export const REFERENCE_REPOSITORY = Symbol('REFERENCE_REPOSITORY');

export interface ReferenceRepository {
  listCurrencies(): Promise<Currency[]>;
  listCountries(): Promise<Country[]>;
  searchCities(
    countryCode: string,
    q: string | undefined,
    limit: number,
  ): Promise<City[]>;
  /**
   * DX-212: CIE-10 por código (con o sin punto) o texto, sin tildes ni
   * mayúsculas. Primero los que EMPIEZAN por lo buscado; luego por código.
   * Sin texto, los primeros por código.
   */
  searchIcd10(q: string | undefined, limit: number): Promise<Icd10Code[]>;
}
