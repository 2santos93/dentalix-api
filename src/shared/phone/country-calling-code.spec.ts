import {
  PROVISIONAL_CALLING_CODES,
  callingCodeOfCountry,
} from './country-calling-code';

// La tabla de `whatsapp-phone.ts:6-31` en 9e958abd, copiada a mano: DX-312
// la mueve sin cambiar ningún valor.
const PREVIOUS_TABLE: Record<string, string> = {
  AR: '54',
  BO: '591',
  BR: '55',
  CA: '1',
  CL: '56',
  CO: '57',
  CR: '506',
  CU: '53',
  DO: '1',
  EC: '593',
  ES: '34',
  GT: '502',
  HN: '504',
  MX: '52',
  NI: '505',
  PA: '507',
  PE: '51',
  PR: '1',
  PT: '351',
  PY: '595',
  SV: '503',
  US: '1',
  UY: '598',
  VE: '58',
};

describe('callingCodeOfCountry (DX-312, provisional hasta DX-329)', () => {
  it('callingCodeOfCountry keeps the 24 codes of the previous table', () => {
    expect(Object.keys(PREVIOUS_TABLE)).toHaveLength(24);
    expect({ ...PROVISIONAL_CALLING_CODES }).toEqual(PREVIOUS_TABLE);
    for (const [country, code] of Object.entries(PREVIOUS_TABLE)) {
      expect([country, callingCodeOfCountry(country)]).toEqual([country, code]);
    }
  });

  it('a country outside the provisional table has no default calling code', () => {
    for (const country of ['JP', 'DE', 'IT', 'ZZ']) {
      expect([country, callingCodeOfCountry(country)]).toEqual([country, null]);
    }
    expect(callingCodeOfCountry(null)).toBeNull();
    expect(callingCodeOfCountry('')).toBeNull();
  });

  it('constructor, toString and __proto__ have no calling code', () => {
    for (const key of [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect([key, callingCodeOfCountry(key)]).toEqual([key, null]);
    }
  });

  it('lowercase and padded countries resolve the same', () => {
    expect(callingCodeOfCountry('ve')).toBe('58');
    expect(callingCodeOfCountry(' VE ')).toBe('58');
    expect(callingCodeOfCountry(' mx')).toBe('52');
  });
});
