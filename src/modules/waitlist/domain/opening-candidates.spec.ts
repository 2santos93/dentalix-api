import {
  OPENING_CANDIDATES_LIMIT,
  rankOpeningCandidates,
  type AppointmentCandidateSource,
  type CandidateSlot,
  type EntryCandidateSource,
} from './opening-candidates';

// En la zona de la sede (UTC−5 fijo): el hueco es el martes 20/10/2026 de 10:00 a 10:30.
const TZ = 'America/Bogota';
const local = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00-05:00`);
const SLOT: CandidateSlot = {
  locationId: 'loc1',
  providerId: 'drx',
  start: local('2026-10-20', '10:00'),
  end: local('2026-10-20', '10:30'),
  timeZone: TZ,
};

function entry(
  id: string,
  over: Partial<EntryCandidateSource> = {},
): EntryCandidateSource {
  return {
    id,
    locationId: 'loc1',
    providerId: null,
    durationMinutes: 30,
    priority: 'NORMAL',
    status: 'OPEN',
    createdAt: new Date('2026-10-01T12:00:00Z'),
    sourceAppointment: null,
    ...over,
  };
}

function appointment(
  id: string,
  over: Partial<AppointmentCandidateSource> = {},
): AppointmentCandidateSource {
  return {
    id,
    locationId: 'loc1',
    providerId: 'drx',
    start: local('2026-11-10', '09:00'),
    end: local('2026-11-10', '09:30'),
    status: 'SCHEDULED',
    wantsEarlier: true,
    createdAt: new Date('2026-10-01T12:00:00Z'),
    ...over,
  };
}

const ids = (r: ReturnType<typeof rankOpeningCandidates>) =>
  r.items.map((i) => i.source.id);

describe('candidatos para un hueco libre (DX-210)', () => {
  it('un pendiente URGENT de 30 min va antes que uno NORMAL; uno de 60 min no cabe', () => {
    const result = rankOpeningCandidates(SLOT, {
      entries: [
        entry('normal', { createdAt: new Date('2026-09-01T00:00:00Z') }),
        entry('urgent', { priority: 'URGENT' }),
        entry('largo', { durationMinutes: 60 }),
      ],
      appointments: [],
    });
    expect(ids(result)).toEqual(['urgent', 'normal']);
    expect(result.truncated).toBe(false);
  });

  it('descarta pendientes de otra sede, cerrados o del profesional de otra columna', () => {
    const result = rankOpeningCandidates(SLOT, {
      entries: [
        entry('otra-sede', { locationId: 'loc2' }),
        entry('agendado', { status: 'SCHEDULED' }),
        entry('otro-prof', { providerId: 'dry' }),
        entry('mismo-prof', { providerId: 'drx' }),
        entry('sin-prof'),
      ],
      appointments: [],
    });
    expect(ids(result)).toEqual(['mismo-prof', 'sin-prof']);
  });

  it('sin profesional en el hueco, cualquier pendiente de la sede vale', () => {
    const result = rankOpeningCandidates(
      { ...SLOT, providerId: null },
      { entries: [entry('a', { providerId: 'dry' })], appointments: [] },
    );
    expect(ids(result)).toEqual(['a']);
  });

  it('no propone el hueco a quien lo acaba de liberar', () => {
    const result = rankOpeningCandidates(SLOT, {
      entries: [
        entry('el-que-cancelo', {
          sourceAppointment: { start: SLOT.start, end: SLOT.end },
        }),
        entry('cancelo-otra', {
          sourceAppointment: {
            start: local('2026-10-19', '10:00'),
            end: local('2026-10-19', '10:30'),
          },
        }),
      ],
      appointments: [],
    });
    expect(ids(result)).toEqual(['cancelo-otra']);
  });

  it('citas con «Adelantar si hay hueco»: futuras, que caben, del mismo profesional y nunca del mismo día', () => {
    const result = rankOpeningCandidates(SLOT, {
      entries: [],
      appointments: [
        appointment('3-semanas'),
        appointment('mismo-dia', {
          start: local('2026-10-20', '17:00'),
          end: local('2026-10-20', '17:30'),
        }),
        // Medianoche de la sede: ya es el día siguiente en la zona de la sede
        // aunque en UTC siga siendo el 21 a las 05:00.
        appointment('manana', {
          start: local('2026-10-21', '00:00'),
          end: local('2026-10-21', '00:30'),
        }),
        appointment('anterior', {
          start: local('2026-10-19', '09:00'),
          end: local('2026-10-19', '09:30'),
        }),
        appointment('sin-marca', { wantsEarlier: false }),
        appointment('cancelada', { status: 'CANCELLED' }),
        appointment('confirmada', { status: 'CONFIRMED' }),
        appointment('larga', { end: local('2026-11-10', '10:00') }),
        appointment('otro-prof', { providerId: 'dry' }),
        appointment('otra-sede', { locationId: 'loc2' }),
      ],
    });
    expect(ids(result).sort()).toEqual(['3-semanas', 'confirmada', 'manana']);
  });

  it('orden: URGENT, pendientes, citas (la más lejana primero) y, a igualdad, la más antigua', () => {
    const old = new Date('2026-08-01T00:00:00Z');
    const result = rankOpeningCandidates(SLOT, {
      entries: [
        entry('normal-nuevo', { createdAt: new Date('2026-10-10T00:00:00Z') }),
        entry('normal-viejo', { createdAt: old }),
        entry('urgente'),
      ].map((e) => (e.id === 'urgente' ? { ...e, priority: 'URGENT' } : e)),
      appointments: [
        appointment('cerca', {
          start: local('2026-10-27', '09:00'),
          end: local('2026-10-27', '09:30'),
        }),
        appointment('lejos-nuevo', {
          createdAt: new Date('2026-10-10T00:00:00Z'),
        }),
        appointment('lejos-viejo', { createdAt: old }),
      ],
    });
    expect(ids(result)).toEqual([
      'urgente',
      'normal-viejo',
      'normal-nuevo',
      'lejos-viejo',
      'lejos-nuevo',
      'cerca',
    ]);
    expect(result.items.map((i) => i.kind)).toEqual([
      'WAITLIST',
      'WAITLIST',
      'WAITLIST',
      'APPOINTMENT',
      'APPOINTMENT',
      'APPOINTMENT',
    ]);
  });

  it(`corta en ${OPENING_CANDIDATES_LIMIT} y lo avisa`, () => {
    const entries = Array.from(
      { length: OPENING_CANDIDATES_LIMIT + 3 },
      (_, i) =>
        entry(`e${String(i).padStart(3, '0')}`, {
          createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
        }),
    );
    const result = rankOpeningCandidates(SLOT, { entries, appointments: [] });
    expect(result.items).toHaveLength(OPENING_CANDIDATES_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.items[0].source.id).toBe('e000');
  });
});
