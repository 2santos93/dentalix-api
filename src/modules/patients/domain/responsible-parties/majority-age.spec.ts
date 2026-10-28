import {
  isMinor,
  isValidMajorityAge,
  MAJORITY_AGE,
  MAJORITY_AGE_MAX,
  MAJORITY_AGE_MESSAGE,
  MAJORITY_AGE_MIN,
  PLATFORM_DEFAULT_MAJORITY_AGE,
} from './majority-age';

const born = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe('isMinor (DX-203: la edad según el país de la sede)', () => {
  it('CO: menor hasta los 18; ES: hasta los 16', () => {
    expect(MAJORITY_AGE).toEqual({ CO: 18, ES: 16 });
    // 17 años el 2026-10-17.
    expect(isMinor(born('2009-03-01'), 'CO', '2026-10-17')).toBe(true);
    expect(isMinor(born('2009-03-01'), 'ES', '2026-10-17')).toBe(false);
    // 15 años: menor en los dos.
    expect(isMinor(born('2011-03-01'), 'ES', '2026-10-17')).toBe(true);
  });

  it('cuenta en el día civil de la sede: cumple justo hoy = ya no es menor', () => {
    expect(isMinor(born('2008-10-17'), 'CO', '2026-10-17')).toBe(false);
    expect(isMinor(born('2008-10-18'), 'CO', '2026-10-17')).toBe(true);
    expect(isMinor(born('2010-10-17'), 'ES', '2026-10-17')).toBe(false);
    expect(isMinor(born('2010-10-18'), 'ES', '2026-10-17')).toBe(true);
  });

  it('sin fecha de nacimiento se trata como adulto', () => {
    expect(isMinor(null, 'CO', '2026-10-17')).toBe(false);
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
