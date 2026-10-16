import { findOpenings, type OpeningsQuery } from './openings';
import type { ScheduleRange } from '../../location-schedule/application/business-hours';

// Martes 20-10-2026 en Bogotá (UTC−5 fijo): 09:00 local = 14:00Z.
const TUESDAY = '2026-10-20';
const WEEKDAY_RANGES: ScheduleRange[] = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startMinute: 9 * 60, endMinute: 13 * 60 },
  { weekday, startMinute: 15 * 60, endMinute: 19 * 60 },
]);
const z = (iso: string) => new Date(iso);
const LONG_AGO = z('2026-01-01T00:00:00.000Z');

function query(overrides: Partial<OpeningsQuery> = {}): OpeningsQuery {
  return {
    fromDay: TUESDAY,
    toDay: TUESDAY,
    timeZone: 'America/Bogota',
    ranges: WEEKDAY_RANGES,
    busy: [],
    durationMinutes: 30,
    now: LONG_AGO,
    ...overrides,
  };
}

function asIso(result: ReturnType<typeof findOpenings>) {
  return result.openings.map((o) => [
    o.start.toISOString(),
    o.end.toISOString(),
  ]);
}

describe('findOpenings (DX-122): horario ∩ ¬bloqueos ∩ ¬citas', () => {
  it('sin nada ocupado, los tramos del horario en la zona de la sede', () => {
    expect(asIso(findOpenings(query()))).toEqual([
      ['2026-10-20T14:00:00.000Z', '2026-10-20T18:00:00.000Z'],
      ['2026-10-20T20:00:00.000Z', '2026-10-21T00:00:00.000Z'],
    ]);
  });

  it('resta citas y bloqueos y descarta los huecos más cortos que la duración', () => {
    const result = findOpenings(
      query({
        busy: [
          // cita 10:00–10:30
          {
            start: z('2026-10-20T15:00:00.000Z'),
            end: z('2026-10-20T15:30:00.000Z'),
          },
          // bloqueo 11:00–12:00
          {
            start: z('2026-10-20T16:00:00.000Z'),
            end: z('2026-10-20T17:00:00.000Z'),
          },
          // cita 12:00–12:40: deja 12:40–13:00 (20 min < 30)
          {
            start: z('2026-10-20T17:00:00.000Z'),
            end: z('2026-10-20T17:40:00.000Z'),
          },
          // bloqueo que cubre toda la tarde y la desborda
          {
            start: z('2026-10-20T19:00:00.000Z'),
            end: z('2026-10-21T03:00:00.000Z'),
          },
        ],
      }),
    );
    expect(asIso(result)).toEqual([
      ['2026-10-20T14:00:00.000Z', '2026-10-20T15:00:00.000Z'],
      ['2026-10-20T15:30:00.000Z', '2026-10-20T16:00:00.000Z'],
    ]);
  });

  it('un hueco exacto de la duración cuenta (medio abierto: contiguo no solapa)', () => {
    const result = findOpenings(
      query({
        ranges: [{ weekday: 2, startMinute: 9 * 60, endMinute: 10 * 60 }],
        busy: [
          {
            start: z('2026-10-20T14:30:00.000Z'),
            end: z('2026-10-20T15:00:00.000Z'),
          },
        ],
      }),
    );
    expect(asIso(result)).toEqual([
      ['2026-10-20T14:00:00.000Z', '2026-10-20T14:30:00.000Z'],
    ]);
  });

  it('un día cerrado no da huecos', () => {
    expect(
      findOpenings(query({ fromDay: '2026-10-18', toDay: '2026-10-18' }))
        .openings,
    ).toEqual([]);
  });

  it('nunca ofrece el pasado: recorta al minuto múltiplo de 5 siguiente a "ahora"', () => {
    const result = findOpenings(query({ now: z('2026-10-20T16:12:30.000Z') }));
    expect(asIso(result)[0]).toEqual([
      '2026-10-20T16:15:00.000Z',
      '2026-10-20T18:00:00.000Z',
    ]);
  });

  it('respeta el cambio de hora de la zona de la sede (Madrid, 29-03-2026)', () => {
    const result = findOpenings(
      query({
        fromDay: '2026-03-28',
        toDay: '2026-03-29',
        timeZone: 'Europe/Madrid',
        ranges: [
          { weekday: 6, startMinute: 9 * 60, endMinute: 13 * 60 },
          { weekday: 0, startMinute: 9 * 60, endMinute: 13 * 60 },
        ],
      }),
    );
    expect(asIso(result)).toEqual([
      ['2026-03-28T08:00:00.000Z', '2026-03-28T12:00:00.000Z'],
      ['2026-03-29T07:00:00.000Z', '2026-03-29T11:00:00.000Z'],
    ]);
  });

  it('cruza la medianoche de la sede: tramo hasta las 24:00 y una cita a caballo', () => {
    const result = findOpenings(
      query({
        fromDay: TUESDAY,
        toDay: '2026-10-21',
        ranges: [
          { weekday: 2, startMinute: 20 * 60, endMinute: 24 * 60 },
          { weekday: 3, startMinute: 0, endMinute: 2 * 60 },
        ],
        // 23:30 del martes – 00:30 del miércoles (hora de Bogotá).
        busy: [
          {
            start: z('2026-10-21T04:30:00.000Z'),
            end: z('2026-10-21T05:30:00.000Z'),
          },
        ],
      }),
    );
    expect(asIso(result)).toEqual([
      ['2026-10-21T01:00:00.000Z', '2026-10-21T04:30:00.000Z'],
      ['2026-10-21T05:30:00.000Z', '2026-10-21T07:00:00.000Z'],
    ]);
  });

  it('corta en `limit` y lo dice', () => {
    const result = findOpenings(
      query({ fromDay: '2026-10-19', toDay: '2026-10-23', limit: 3 }),
    );
    expect(result.openings).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(findOpenings(query()).truncated).toBe(false);
  });
});
