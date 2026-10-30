// Excepción G5.3 (DX-334): país de sede anterior a DX-312.
import { ISO3166_COUNTRIES } from '../../../prisma/reference/iso3166';
import { legacyClinicCountry } from './legacy-clinic-country';

describe('legacyClinicCountry', () => {
  it('legacy: CO and ES project to themselves', () => {
    expect(legacyClinicCountry('CO')).toBe('CO');
    expect(legacyClinicCountry('ES')).toBe('ES');
  });

  it('every other listed country projects to null', () => {
    const others = ISO3166_COUNTRIES.map((c) => c.code).filter(
      (code) => code !== 'CO' && code !== 'ES',
    );
    expect(others).toHaveLength(248);
    for (const code of others) expect(legacyClinicCountry(code)).toBeNull();
  });

  it('lowercase and padded input project the same', () => {
    expect(legacyClinicCountry(' co ')).toBe('CO');
    expect(legacyClinicCountry('es')).toBe('ES');
    expect(legacyClinicCountry(' ve')).toBeNull();
  });

  it('constructor, toString and __proto__ project to null', () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(legacyClinicCountry(key)).toBeNull();
    }
  });
});
