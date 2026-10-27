import { regionalFormat } from '../../../shared/format/regional-format';
import { startsAtLabel } from './starts-at-label';

const h12 = regionalFormat({ locale: 'es-CO', hourCycle: 'h12' });
const h23 = regionalFormat({ locale: 'es-CO', hourCycle: 'h23' });

describe('startsAtLabel (DX-026, DX-350)', () => {
  it('fecha y hora en la zona de la sede, en español', () => {
    // 14:30 UTC = 9:30 en UTC-5.
    expect(
      startsAtLabel(
        new Date('2026-10-20T14:30:00.000Z'),
        'America/Bogota',
        h12,
      ),
    ).toBe('martes 20 de octubre de 2026 a las 9:30 a. m.');
  });

  it('reminder clock follows the location hourCycle, never the country', () => {
    const start = new Date('2026-10-20T20:05:00.000Z');
    // Misma sede (misma zona y locale): solo cambia su ajuste de reloj.
    expect(startsAtLabel(start, 'America/Bogota', h12)).toBe(
      'martes 20 de octubre de 2026 a las 3:05 p. m.',
    );
    expect(startsAtLabel(start, 'America/Bogota', h23)).toBe(
      'martes 20 de octubre de 2026 a las 15:05',
    );
  });

  it('reminder words stay Spanish for en-US and ja-JP', () => {
    // 01:00 UTC del 21 = 10:00 del 21 en Tokio; 21:00 del 20 en Nueva York.
    const start = new Date('2026-10-21T01:00:00.000Z');
    expect(
      startsAtLabel(
        start,
        'America/New_York',
        regionalFormat({ locale: 'en-US', hourCycle: 'h12' }),
      ),
    ).toBe('martes 20 de octubre de 2026 a las 9:00 p. m.');
    expect(
      startsAtLabel(
        start,
        'Asia/Tokyo',
        regionalFormat({ locale: 'ja-JP', hourCycle: 'h12' }),
      ),
    ).toBe('miércoles 21 de octubre de 2026 a las 10:00 a. m.');
  });

  it('cambia de día si la zona lo pide', () => {
    // 03:00 UTC del 21 = 22:00 del 20 en UTC-5.
    expect(
      startsAtLabel(
        new Date('2026-10-21T03:00:00.000Z'),
        'America/Bogota',
        h12,
      ),
    ).toBe('martes 20 de octubre de 2026 a las 10:00 p. m.');
  });

  it('sigue el horario de verano de la zona', () => {
    const berlin = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });
    // 14:30 UTC en julio = 16:30 en Berlín (UTC+2); en noviembre (UTC+1), 15:30.
    expect(
      startsAtLabel(
        new Date('2026-07-14T14:30:00.000Z'),
        'Europe/Berlin',
        berlin,
      ),
    ).toBe('martes 14 de julio de 2026 a las 16:30');
    expect(
      startsAtLabel(
        new Date('2026-11-10T14:30:00.000Z'),
        'Europe/Berlin',
        berlin,
      ),
    ).toBe('martes 10 de noviembre de 2026 a las 15:30');
  });
});
