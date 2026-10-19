import { isMinor, MAJORITY_AGE } from './majority-age';

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
