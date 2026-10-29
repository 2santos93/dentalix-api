import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Country } from 'country-state-city';
import { ISO3166_COUNTRIES } from '../../../prisma/reference/iso3166';

const reference = (file: string): string =>
  readFileSync(join(__dirname, '../../../prisma/reference', file), 'utf8');

const codes = ISO3166_COUNTRIES.map((c) => c.code);

describe('ISO3166_COUNTRIES', () => {
  it('the generated list has 250 unique ISO alpha-2 codes sorted by code', () => {
    expect(ISO3166_COUNTRIES).toHaveLength(250);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{2}$/);
    expect(codes).toEqual([...new Set(codes)].sort());
  });

  it('every name is the Spanish CLDR name and never the code', () => {
    const name = (code: string) =>
      ISO3166_COUNTRIES.find((c) => c.code === code)?.name;
    expect(name('ES')).toBe('España');
    expect(name('VE')).toBe('Venezuela');
    expect(name('US')).toBe('Estados Unidos');
    expect(name('CI')).toBe('Côte d’Ivoire');
    for (const country of ISO3166_COUNTRIES) {
      expect(country.name).not.toBe(country.code);
      expect(country.name.charAt(0)).toBe(
        country.name.charAt(0).toLocaleUpperCase('es'),
      );
    }
  });

  it('it keeps every code the countries table had before', () => {
    const previous = Country.getAllCountries().map((c) => c.isoCode);
    expect([...codes].sort()).toEqual([...previous].sort());
  });

  it('the JSON copy has the same entries in the same order', () => {
    const json: unknown = JSON.parse(reference('iso3166-countries.json'));
    expect(json).toEqual(ISO3166_COUNTRIES.map((c) => ({ ...c })));
  });

  it('the header records the source versions and the licences', () => {
    const header = reference('iso3166.ts')
      .split('\n')
      .filter((line) => line.startsWith('//'))
      .join('\n');
    for (const text of [
      'country-state-city',
      'Node 22.',
      'ICU',
      'CLDR',
      'GPL-3.0',
      'Unicode License',
    ]) {
      expect(header).toContain(text);
    }
  });
});
