import { civilDateIn, isSameCivilDay } from './void-window';

describe('void window', () => {
  it('formatea el día civil en la zona dada', () => {
    const instant = new Date('2026-10-16T02:00:00.000Z');
    expect(civilDateIn(instant, 'UTC')).toBe('2026-10-16');
    expect(civilDateIn(instant, 'America/Bogota')).toBe('2026-10-15');
  });

  it('compara días de la sede, no días UTC', () => {
    const a = new Date('2026-10-16T04:59:00.000Z'); // 23:59 del 15 en Bogotá
    const b = new Date('2026-10-16T05:00:00.000Z'); // 00:00 del 16 en Bogotá
    expect(isSameCivilDay(a, b, 'UTC')).toBe(true);
    expect(isSameCivilDay(a, b, 'America/Bogota')).toBe(false);
  });
});
