import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { ISO3166_COUNTRIES } from '../../../prisma/reference/iso3166';
import { PHONE_REGIONS } from '../../../prisma/reference/phone-regions';

const reference = (file: string): string =>
  readFileSync(join(__dirname, '../../../prisma/reference', file), 'utf8');

const json = (): unknown => JSON.parse(reference('phone-regions.json'));

const codes = PHONE_REGIONS.map((r) => r.code);

describe('PHONE_REGIONS', () => {
  it('phone regions match the installed libphonenumber-js', () => {
    const installed = [...getCountries()].sort().map((code) => ({
      code,
      callingCode: getCountryCallingCode(code),
    }));
    const listed = (json() as { code: string; callingCode: string }[]).map(
      ({ code, callingCode }) => ({ code, callingCode }),
    );
    expect(listed).toEqual(installed);
    expect(json()).toEqual(PHONE_REGIONS.map((r) => ({ ...r })));
    expect(PHONE_REGIONS).toHaveLength(245);
  });

  it('lists the numbering regions of the library, not the ISO countries', () => {
    expect(codes).toEqual(expect.arrayContaining(['AC', 'TA']));
    for (const code of ['AQ', 'BV', 'GS', 'HM', 'PN', 'TF', 'UM']) {
      expect(codes).not.toContain(code);
    }
    expect(PHONE_REGIONS.find((r) => r.code === 'VE')?.callingCode).toBe('58');
  });

  it('every region has a valid code, calling code and a name that is not the code', () => {
    expect(codes).toEqual([...new Set(codes)].sort());
    for (const region of PHONE_REGIONS) {
      expect(region.code).toMatch(/^[A-Z]{2}$/);
      expect(region.callingCode).toMatch(/^\d{1,3}$/);
      expect(region.name).not.toBe(region.code);
    }
  });

  it('a region that is also an ISO country has the same name as the ISO list', () => {
    const isoName = new Map(ISO3166_COUNTRIES.map((c) => [c.code, c.name]));
    const shared = PHONE_REGIONS.filter((r) => isoName.has(r.code));
    expect(shared).toHaveLength(243);
    for (const region of shared) {
      expect(region.name).toBe(isoName.get(region.code));
    }
  });

  it('the header records the source versions and the licences', () => {
    const header = reference('phone-regions.ts')
      .split('\n')
      .filter((line) => line.startsWith('//'))
      .join('\n');
    for (const text of [
      'libphonenumber-js 1.13.15',
      'Node 22.',
      'ICU',
      'CLDR',
      'MIT',
      'Apache-2.0',
      'Unicode License',
    ]) {
      expect(header).toContain(text);
    }
  });
});
