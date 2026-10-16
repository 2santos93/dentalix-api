import { startsAtLabel } from './starts-at-label';

describe('startsAtLabel (DX-026)', () => {
  it('fecha y hora en la zona de la sede, en español (Bogotá, 12 h)', () => {
    // 14:30 UTC = 9:30 en Bogotá (UTC-5).
    expect(
      startsAtLabel(
        new Date('2026-10-20T14:30:00.000Z'),
        'America/Bogota',
        'CO',
      ),
    ).toBe('martes 20 de octubre de 2026 a las 9:30 a. m.');
  });

  it('la tarde en 12 h lleva «p. m.»', () => {
    expect(
      startsAtLabel(
        new Date('2026-10-20T20:05:00.000Z'),
        'America/Bogota',
        'CO',
      ),
    ).toBe('martes 20 de octubre de 2026 a las 3:05 p. m.');
  });

  it('cambia de día si la zona lo pide', () => {
    // 03:00 UTC del 21 = 22:00 del 20 en Bogotá.
    expect(
      startsAtLabel(
        new Date('2026-10-21T03:00:00.000Z'),
        'America/Bogota',
        'CO',
      ),
    ).toBe('martes 20 de octubre de 2026 a las 10:00 p. m.');
  });

  it('una sede de España usa su zona (con horario de verano) y 24 h', () => {
    // 14:30 UTC en julio = 16:30 en Madrid (UTC+2).
    expect(
      startsAtLabel(new Date('2026-07-14T14:30:00.000Z'), 'Europe/Madrid', 'ES'),
    ).toBe('martes 14 de julio de 2026 a las 16:30');
    // En noviembre (UTC+1) la misma hora UTC es una hora menos.
    expect(
      startsAtLabel(new Date('2026-11-10T14:30:00.000Z'), 'Europe/Madrid', 'ES'),
    ).toBe('martes 10 de noviembre de 2026 a las 15:30');
  });
});
