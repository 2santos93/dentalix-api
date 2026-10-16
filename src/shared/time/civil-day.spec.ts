import {
  addCivilDays,
  civilDateIn,
  civilDayRange,
  civilNoonIn,
  civilPeriodByZone,
  civilRangeInZone,
  isValidTimeZone,
  parseCivilDate,
  zonedStartOfDay,
} from './civil-day';

const iso = (d: Date) => d.toISOString();

describe('civil-day (DX-097)', () => {
  describe('parseCivilDate', () => {
    it('acepta un día real YYYY-MM-DD', () => {
      expect(parseCivilDate('2026-10-16')).toBe('2026-10-16');
      expect(parseCivilDate('2028-02-29')).toBe('2028-02-29');
    });

    it('rechaza formas inválidas y días que no existen', () => {
      for (const bad of [
        '2026-02-30',
        '2027-02-29',
        '2026-13-01',
        '2026-1-01',
        '16/10/2026',
        '2026-10-16T00:00:00Z',
        '',
      ]) {
        expect(parseCivilDate(bad)).toBeNull();
      }
    });
  });

  describe('addCivilDays', () => {
    it('cruza fin de mes y de año, y resta', () => {
      expect(addCivilDays('2026-10-31', 1)).toBe('2026-11-01');
      expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01');
      expect(addCivilDays('2026-03-01', -1)).toBe('2026-02-28');
    });
  });

  describe('isValidTimeZone', () => {
    it('acepta IANA y rechaza basura', () => {
      expect(isValidTimeZone('America/Bogota')).toBe(true);
      expect(isValidTimeZone('Europe/Madrid')).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(isValidTimeZone('Mars/Olympus')).toBe(false);
      expect(isValidTimeZone('')).toBe(false);
    });
  });

  describe('civilDateIn', () => {
    it('20:00 en Bogotá del 16 es el 17 en UTC pero el 16 en la sede', () => {
      const instant = new Date('2026-10-17T01:00:00.000Z');
      expect(civilDateIn(instant, 'America/Bogota')).toBe('2026-10-16');
      expect(civilDateIn(instant, 'UTC')).toBe('2026-10-17');
    });
  });

  describe('zonedStartOfDay / civilDayRange', () => {
    it('Bogotá (UTC-5 fijo): el día empieza a las 05:00 UTC y dura 24 h', () => {
      const { start, end } = civilDayRange('2026-10-16', 'America/Bogota');
      expect(iso(start)).toBe('2026-10-16T05:00:00.000Z');
      expect(iso(end)).toBe('2026-10-17T05:00:00.000Z');
    });

    it('un abono a las 20:00 de Bogotá cae en ese día y no en el siguiente', () => {
      const paidAt = new Date('2026-10-17T01:00:00.000Z'); // 16/10 20:00 -05
      const today = civilDayRange('2026-10-16', 'America/Bogota');
      const tomorrow = civilDayRange('2026-10-17', 'America/Bogota');
      expect(paidAt >= today.start && paidAt < today.end).toBe(true);
      expect(paidAt >= tomorrow.start && paidAt < tomorrow.end).toBe(false);
    });

    it('Madrid, cambio de octubre (25/10/2026): el día dura 25 h', () => {
      const { start, end } = civilDayRange('2026-10-25', 'Europe/Madrid');
      expect(iso(start)).toBe('2026-10-24T22:00:00.000Z'); // 00:00 CEST
      expect(iso(end)).toBe('2026-10-25T23:00:00.000Z'); // 00:00 CET
      expect(end.getTime() - start.getTime()).toBe(25 * 3600 * 1000);
    });

    it('Madrid, cambio de marzo (29/03/2026): el día dura 23 h', () => {
      const { start, end } = civilDayRange('2026-03-29', 'Europe/Madrid');
      expect(iso(start)).toBe('2026-03-28T23:00:00.000Z'); // 00:00 CET
      expect(iso(end)).toBe('2026-03-29T22:00:00.000Z'); // 00:00 CEST
      expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
    });

    it('zona cuyo cambio de hora salta la medianoche: el día empieza a la 01:00', () => {
      // America/Santiago adelanta 00:00 -> 01:00 el 6/9/2026 (-04 -> -03).
      const start = zonedStartOfDay('2026-09-06', 'America/Santiago');
      expect(iso(start)).toBe('2026-09-06T04:00:00.000Z');
      expect(civilDateIn(start, 'America/Santiago')).toBe('2026-09-06');
      expect(
        civilDateIn(new Date(start.getTime() - 1), 'America/Santiago'),
      ).toBe('2026-09-05');
    });

    it('rechaza un día inválido o una zona inválida', () => {
      expect(() => civilDayRange('2026-02-30', 'America/Bogota')).toThrow();
      expect(() => civilDayRange('2026-10-16', 'Mars/Olympus')).toThrow();
    });
  });

  describe('civilRangeInZone (from/to inclusivos)', () => {
    it('Madrid del 24 al 25 de octubre: incluye las 23:59 del 25 (CET) y excluye la medianoche del 26', () => {
      const { start, end } = civilRangeInZone(
        '2026-10-24',
        '2026-10-25',
        'Europe/Madrid',
      );
      expect(iso(start)).toBe('2026-10-23T22:00:00.000Z');
      expect(iso(end)).toBe('2026-10-25T23:00:00.000Z');
      const lastMinute = new Date('2026-10-25T22:59:00.000Z'); // 23:59 CET
      const nextMidnight = new Date('2026-10-25T23:00:00.000Z'); // 26 00:00
      expect(lastMinute >= start && lastMinute < end).toBe(true);
      expect(nextMidnight < end).toBe(false);
      // La hora repetida (02:00-03:00 dos veces) está dentro, las dos veces.
      const firstTwoThirty = new Date('2026-10-25T00:30:00.000Z'); // 02:30 CEST
      const secondTwoThirty = new Date('2026-10-25T01:30:00.000Z'); // 02:30 CET
      expect(firstTwoThirty >= start && firstTwoThirty < end).toBe(true);
      expect(secondTwoThirty >= start && secondTwoThirty < end).toBe(true);
    });

    it('mes de octubre en Bogotá: incluye el 31 a las 22:00 y excluye el 1/11 a las 00:30', () => {
      const { start, end } = civilRangeInZone(
        '2026-10-01',
        '2026-10-31',
        'America/Bogota',
      );
      const oct31Late = new Date('2026-11-01T03:00:00.000Z'); // 31/10 22:00 -05
      const nov1Early = new Date('2026-11-01T05:30:00.000Z'); // 1/11 00:30 -05
      expect(oct31Late >= start && oct31Late < end).toBe(true);
      expect(nov1Early >= start && nov1Early < end).toBe(false);
    });

    it('from > to es un error', () => {
      expect(() =>
        civilRangeInZone('2026-10-02', '2026-10-01', 'America/Bogota'),
      ).toThrow();
    });
  });
});

describe('civilPeriodByZone (varias sedes)', () => {
  it('agrupa las sedes por zona y cada grupo corta el día en la suya', () => {
    const branches = civilPeriodByZone(
      '2026-10-16',
      '2026-10-16',
      new Map([
        ['bog-1', 'America/Bogota'],
        ['mad-1', 'Europe/Madrid'],
        ['bog-2', 'America/Bogota'],
      ]),
    );
    expect(branches).toEqual([
      {
        timeZone: 'America/Bogota',
        locationIds: ['bog-1', 'bog-2'],
        start: new Date('2026-10-16T05:00:00.000Z'),
        end: new Date('2026-10-17T05:00:00.000Z'),
      },
      {
        timeZone: 'Europe/Madrid',
        locationIds: ['mad-1'],
        start: new Date('2026-10-15T22:00:00.000Z'),
        end: new Date('2026-10-16T22:00:00.000Z'),
      },
    ]);
  });

  it('sin sedes no hay ramas', () => {
    expect(civilPeriodByZone('2026-10-16', '2026-10-16', new Map())).toEqual(
      [],
    );
  });
});

describe('civilNoonIn', () => {
  it('es el mediodía del día civil en la zona (dentro del día en cualquier zona)', () => {
    expect(civilNoonIn('2026-10-16', 'America/Bogota').toISOString()).toBe(
      '2026-10-16T17:00:00.000Z',
    );
    expect(civilNoonIn('2026-10-16', 'Europe/Madrid').toISOString()).toBe(
      '2026-10-16T10:00:00.000Z',
    );
    const noon = civilNoonIn('2026-10-25', 'Europe/Madrid');
    expect(civilDateIn(noon, 'Europe/Madrid')).toBe('2026-10-25');
  });
});
