import {
  SERIES_DATE_MESSAGES,
  SeriesRecurrenceError,
  oneYearAfter,
  overlappingWithin,
  seriesDates,
  shiftedStart,
} from './series-dates';
import { civilDateIn, wallMillisOfDay } from '../../../shared/time/civil-day';

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();

describe('seriesDates (DX-562)', () => {
  const caracas = 'America/Caracas';

  it('cada semana × 6 en Caracas: misma hora de pared y duración, la base primero', () => {
    const slots = seriesDates({
      start: at('2027-01-18T13:00:00.000Z'), // lunes 09:00 (UTC−4)
      end: at('2027-01-18T13:45:00.000Z'),
      timeZone: caracas,
      intervalWeeks: 1,
      count: 6,
    });
    expect(slots.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(slots.map((s) => iso(s.start))).toEqual([
      '2027-01-18T13:00:00.000Z',
      '2027-01-25T13:00:00.000Z',
      '2027-02-01T13:00:00.000Z',
      '2027-02-08T13:00:00.000Z',
      '2027-02-15T13:00:00.000Z',
      '2027-02-22T13:00:00.000Z',
    ]);
    for (const s of slots) {
      expect(s.end.getTime() - s.start.getTime()).toBe(45 * 60_000);
    }
  });

  it('cada 4 semanas', () => {
    const slots = seriesDates({
      start: at('2027-01-18T19:30:00.000Z'),
      end: at('2027-01-18T20:30:00.000Z'),
      timeZone: caracas,
      intervalWeeks: 4,
      count: 3,
    });
    expect(slots.map((s) => civilDateIn(s.start, caracas))).toEqual([
      '2027-01-18',
      '2027-02-15',
      '2027-03-15',
    ]);
  });

  it('conserva los segundos y milisegundos de la base', () => {
    const slots = seriesDates({
      start: at('2027-01-18T13:00:07.250Z'),
      end: at('2027-01-18T14:00:07.250Z'),
      timeZone: caracas,
      intervalWeeks: 2,
      count: 2,
    });
    expect(iso(slots[1].start)).toBe('2027-02-01T13:00:07.250Z');
  });

  it('cambio de hora de primavera (Nueva York): las 10:00 siguen a las 10:00', () => {
    const ny = 'America/New_York';
    const slots = seriesDates({
      start: at('2027-03-07T15:00:00.000Z'), // 10:00 EST (UTC−5)
      end: at('2027-03-07T16:00:00.000Z'),
      timeZone: ny,
      intervalWeeks: 1,
      count: 3,
    });
    expect(slots.map((s) => iso(s.start))).toEqual([
      '2027-03-07T15:00:00.000Z',
      '2027-03-14T14:00:00.000Z', // 10:00 EDT (UTC−4): el día del cambio
      '2027-03-21T14:00:00.000Z',
    ]);
    for (const s of slots) {
      expect(wallMillisOfDay(s.start, ny)).toBe(10 * HOUR);
      expect(s.end.getTime() - s.start.getTime()).toBe(HOUR);
    }
  });

  it('cambio de hora de otoño (Nueva York): y de vuelta', () => {
    const ny = 'America/New_York';
    const slots = seriesDates({
      start: at('2027-10-31T14:00:00.000Z'), // 10:00 EDT
      end: at('2027-10-31T14:30:00.000Z'),
      timeZone: ny,
      intervalWeeks: 1,
      count: 2,
    });
    expect(iso(slots[1].start)).toBe('2027-11-07T15:00:00.000Z'); // 10:00 EST
    expect(wallMillisOfDay(slots[1].start, ny)).toBe(10 * HOUR);
  });

  it('Madrid: ida y vuelta del horario de verano', () => {
    const madrid = 'Europe/Madrid';
    const spring = seriesDates({
      start: at('2027-03-21T08:00:00.000Z'), // 09:00 CET
      end: at('2027-03-21T09:00:00.000Z'),
      timeZone: madrid,
      intervalWeeks: 1,
      count: 2,
    });
    expect(iso(spring[1].start)).toBe('2027-03-28T07:00:00.000Z'); // 09:00 CEST
    const autumn = seriesDates({
      start: at('2027-10-24T07:00:00.000Z'), // 09:00 CEST
      end: at('2027-10-24T08:00:00.000Z'),
      timeZone: madrid,
      intervalWeeks: 1,
      count: 2,
    });
    expect(iso(autumn[1].start)).toBe('2027-10-31T08:00:00.000Z'); // 09:00 CET
  });

  it('una hora que no existe ese día (02:30 del adelanto) cae el mismo día, como zonedWallTime', () => {
    const ny = 'America/New_York';
    const slots = seriesDates({
      start: at('2027-03-07T07:30:00.000Z'), // 02:30 EST
      end: at('2027-03-07T08:00:00.000Z'),
      timeZone: ny,
      intervalWeeks: 1,
      count: 2,
    });
    // 02:30 no existe el 14/03: zonedWallTime da 06:30Z (01:30 EST), el
    // mismo día civil; la vista previa enseña esa hora y se puede cambiar.
    expect(iso(slots[1].start)).toBe('2027-03-14T06:30:00.000Z');
    expect(civilDateIn(slots[1].start, ny)).toBe('2027-03-14');
  });

  it('la medianoche que no existe (Santiago): el primer instante del día', () => {
    const santiago = 'America/Santiago';
    const slots = seriesDates({
      start: at('2027-08-29T04:00:00.000Z'), // domingo 00:00 (UTC−4)
      end: at('2027-08-29T04:30:00.000Z'),
      timeZone: santiago,
      intervalWeeks: 1,
      count: 2,
    });
    // El 05/09/2027 el reloj salta de 00:00 a 01:00 (UTC−3).
    expect(civilDateIn(slots[1].start, santiago)).toBe('2027-09-05');
    expect(iso(slots[1].start)).toBe('2027-09-05T04:00:00.000Z');
  });

  it('fin de mes y año bisiesto: se suman días, no meses', () => {
    const endOfMonth = seriesDates({
      start: at('2027-01-31T14:00:00.000Z'),
      end: at('2027-01-31T15:00:00.000Z'),
      timeZone: caracas,
      intervalWeeks: 4,
      count: 3,
    });
    expect(endOfMonth.map((s) => civilDateIn(s.start, caracas))).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-28',
    ]);
    const leap = seriesDates({
      start: at('2028-02-22T14:00:00.000Z'),
      end: at('2028-02-22T15:00:00.000Z'),
      timeZone: caracas,
      intervalWeeks: 1,
      count: 2,
    });
    expect(civilDateIn(leap[1].start, caracas)).toBe('2028-02-29');
  });

  describe('hasta una fecha (`until`)', () => {
    const base = {
      start: at('2027-01-04T13:00:00.000Z'), // lunes
      end: at('2027-01-04T14:00:00.000Z'),
      timeZone: caracas,
      intervalWeeks: 1,
    };

    it('incluye el día exacto de `until`', () => {
      expect(seriesDates({ ...base, until: '2027-01-25' })).toHaveLength(4);
      expect(seriesDates({ ...base, until: '2027-01-24' })).toHaveLength(3);
    });

    it('26 citas caben; 27 no', () => {
      expect(seriesDates({ ...base, until: '2027-06-28' })).toHaveLength(26);
      expect(() => seriesDates({ ...base, until: '2027-07-05' })).toThrow(
        SERIES_DATE_MESSAGES.untilTooMany,
      );
    });

    it('como mucho a un año de la base', () => {
      expect(
        seriesDates({ ...base, intervalWeeks: 12, until: '2028-01-04' }),
      ).toHaveLength(5);
      expect(() =>
        seriesDates({ ...base, intervalWeeks: 12, until: '2028-01-05' }),
      ).toThrow(SERIES_DATE_MESSAGES.untilTooFar);
    });

    it('anterior a la base, una sola cita o día inválido: 400 en español', () => {
      expect(() => seriesDates({ ...base, until: '2027-01-03' })).toThrow(
        SERIES_DATE_MESSAGES.untilBeforeStart,
      );
      expect(() => seriesDates({ ...base, until: '2027-01-10' })).toThrow(
        SERIES_DATE_MESSAGES.untilTooFew,
      );
      expect(() => seriesDates({ ...base, until: '2027-02-30' })).toThrow(
        SERIES_DATE_MESSAGES.untilInvalid,
      );
    });

    it('el día de `until` es civil en la zona de la sede, no en UTC', () => {
      // Lunes 22:00 en Caracas = martes 02:00 UTC.
      const late = {
        ...base,
        start: at('2027-01-05T02:00:00.000Z'),
        end: at('2027-01-05T02:30:00.000Z'),
      };
      expect(seriesDates({ ...late, until: '2027-01-11' })).toHaveLength(2);
    });
  });

  describe('topes', () => {
    const base = {
      start: at('2027-01-04T13:00:00.000Z'),
      end: at('2027-01-04T14:00:00.000Z'),
      timeZone: caracas,
    };

    it.each([0, 13, 1.5, -1])(
      'intervalo %p semanas: error',
      (intervalWeeks) => {
        expect(() => seriesDates({ ...base, intervalWeeks, count: 3 })).toThrow(
          SERIES_DATE_MESSAGES.interval,
        );
      },
    );

    it.each([1, 27, 2.5])('%p citas: error', (count) => {
      expect(() => seriesDates({ ...base, intervalWeeks: 1, count })).toThrow(
        SERIES_DATE_MESSAGES.count,
      );
    });

    it('2 y 26 citas, 1 y 12 semanas: valen', () => {
      expect(seriesDates({ ...base, intervalWeeks: 1, count: 2 })).toHaveLength(
        2,
      );
      expect(
        seriesDates({ ...base, intervalWeeks: 12, count: 26 }),
      ).toHaveLength(26);
    });

    it('ni `count` ni `until`, o los dos: error', () => {
      expect(() => seriesDates({ ...base, intervalWeeks: 1 })).toThrow(
        SERIES_DATE_MESSAGES.countOrUntil,
      );
      expect(() =>
        seriesDates({
          ...base,
          intervalWeeks: 1,
          count: 3,
          until: '2027-02-01',
        }),
      ).toThrow(SERIES_DATE_MESSAGES.countOrUntil);
    });

    it('fin no posterior al inicio: error', () => {
      expect(() =>
        seriesDates({ ...base, end: base.start, intervalWeeks: 1, count: 2 }),
      ).toThrow(SeriesRecurrenceError);
    });
  });
});

describe('oneYearAfter (DX-562)', () => {
  it('mismo día y mes del año siguiente; el 29/02 pasa al 28/02', () => {
    expect(oneYearAfter('2027-01-04')).toBe('2028-01-04');
    expect(oneYearAfter('2028-02-29')).toBe('2029-02-28');
  });
});

describe('shiftedStart (DX-562, mover esta y las siguientes)', () => {
  const caracas = 'America/Caracas';

  it('el pivote va exactamente a la hora nueva', () => {
    const from = at('2027-01-18T13:00:00.000Z');
    const to = at('2027-01-19T19:15:00.000Z');
    expect(iso(shiftedStart(from, from, to, caracas))).toBe(iso(to));
  });

  it('las siguientes: los mismos días de calendario y la nueva hora de pared', () => {
    const from = at('2027-01-18T13:00:00.000Z'); // lunes 09:00
    const to = at('2027-01-19T19:15:00.000Z'); // martes 15:15
    expect(
      iso(shiftedStart(at('2027-02-15T13:00:00.000Z'), from, to, caracas)),
    ).toBe('2027-02-16T19:15:00.000Z');
  });

  it('hacia atrás y a través de un cambio de hora (Nueva York)', () => {
    const ny = 'America/New_York';
    const from = at('2027-03-08T15:00:00.000Z'); // lunes 10:00 EST
    const to = at('2027-03-05T14:00:00.000Z'); // viernes 09:00 EST
    // La del 15/03 (10:00 EDT) pasa al viernes 12/03 a las 09:00 EST.
    expect(
      iso(shiftedStart(at('2027-03-15T14:00:00.000Z'), from, to, ny)),
    ).toBe('2027-03-12T14:00:00.000Z');
    // La del 22/03 pasa al 19/03 a las 09:00 EDT.
    expect(
      iso(shiftedStart(at('2027-03-22T14:00:00.000Z'), from, to, ny)),
    ).toBe('2027-03-19T13:00:00.000Z');
  });
});

describe('overlappingWithin (DX-562)', () => {
  const slot = (s: string, e: string) => ({ start: at(s), end: at(e) });

  it('sin choques: vacío; contiguas no chocan', () => {
    expect(
      overlappingWithin([
        slot('2027-01-18T13:00:00Z', '2027-01-18T14:00:00Z'),
        slot('2027-01-18T14:00:00Z', '2027-01-18T15:00:00Z'),
      ]).size,
    ).toBe(0);
  });

  it('marca las dos que se solapan (por su posición en la lista)', () => {
    expect(
      [
        ...overlappingWithin([
          slot('2027-01-25T13:00:00Z', '2027-01-25T14:00:00Z'),
          slot('2027-01-18T13:00:00Z', '2027-01-18T14:00:00Z'),
          slot('2027-01-18T13:30:00Z', '2027-01-18T14:30:00Z'),
        ]),
      ].sort(),
    ).toEqual([1, 2]);
  });

  it('una larga que tapa a dos', () => {
    expect(
      [
        ...overlappingWithin([
          slot('2027-01-18T13:00:00Z', '2027-01-18T17:00:00Z'),
          slot('2027-01-18T14:00:00Z', '2027-01-18T14:30:00Z'),
          slot('2027-01-18T16:00:00Z', '2027-01-18T16:30:00Z'),
        ]),
      ].sort(),
    ).toEqual([0, 1, 2]);
  });
});
