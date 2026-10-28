import {
  isMinor,
  isValidMajorityAge,
  MAJORITY_AGE_MAX,
  MAJORITY_AGE_MESSAGE,
  MAJORITY_AGE_MIN,
  PLATFORM_DEFAULT_MAJORITY_AGE,
} from './majority-age';

describe('isMinor (DX-328: la mayoría de edad de la clínica)', () => {
  it('isMinor with majorityAge 16, 18 and 20 on the day before, of and after the birthday', () => {
    for (const n of [16, 18, 20]) {
      const born = new Date(`${2026 - n}-10-17T00:00:00.000Z`);
      expect(isMinor(born, n, '2026-10-16')).toBe(true);
      expect(isMinor(born, n, '2026-10-17')).toBe(false);
      expect(isMinor(born, n, '2026-10-18')).toBe(false);
    }
    expect(isMinor(null, 20, '2026-10-17')).toBe(false);
  });
});

describe('mayoría de edad por clínica (DX-328): constantes y validación', () => {
  it('platform default and limits', () => {
    expect(PLATFORM_DEFAULT_MAJORITY_AGE).toBe(18);
    expect(MAJORITY_AGE_MIN).toBe(14);
    expect(MAJORITY_AGE_MAX).toBe(21);
    expect(MAJORITY_AGE_MESSAGE).toBe(
      'La mayoría de edad tiene que ser un número entero de años entre 14 y 21.',
    );
  });

  it('isValidMajorityAge accepts 14..21 integers only', () => {
    for (const value of [13, 22, 18.5, '18', null]) {
      expect(isValidMajorityAge(value)).toBe(false);
    }
    for (const value of [14, 16, 18, 20, 21]) {
      expect(isValidMajorityAge(value)).toBe(true);
    }
  });
});
