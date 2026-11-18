import {
  clampOnlineDays,
  computeOnlineSlots,
  type OnlineSlotsQuery,
} from './online-slots';

// Caracas: UTC-4 todo el año. 2026-11-23 es lunes.
const TZ = 'America/Caracas';
const at = (iso: string) => new Date(`${iso}-04:00`);
const MON = 1;

function query(overrides: Partial<OnlineSlotsQuery> = {}): OnlineSlotsQuery {
  return {
    fromDay: '2026-11-23',
    toDay: '2026-11-23',
    timeZone: TZ,
    ranges: [{ weekday: MON, startMinute: 9 * 60, endMinute: 12 * 60 }],
    isClosedDay: () => false,
    providers: [{ providerId: 'p1', busy: [] }],
    durationMinutes: 30,
    stepMinutes: 30,
    now: at('2026-11-20T08:00:00'),
    minLeadMinutes: 120,
    maxAdvanceDays: 60,
    ...overrides,
  };
}

const starts = (q: OnlineSlotsQuery) =>
  computeOnlineSlots(q).slots.map((s) => s.start.toISOString().slice(11, 16));

describe('computeOnlineSlots (DX-016)', () => {
  it('ofrece los inicios del horario de la sede alineados al paso, con la duración entera dentro', () => {
    // 9:00–12:00 local = 13:00–16:00 UTC; 30 min cada 30 → 9:00 … 11:30.
    expect(starts(query())).toEqual([
      '13:00',
      '13:30',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
    ]);
    const [first] = computeOnlineSlots(query()).slots;
    expect(first).toEqual({
      start: at('2026-11-23T09:00:00'),
      end: at('2026-11-23T09:30:00'),
      providerId: 'p1',
    });
  });

  it('sin horario configurado en la sede no ofrece nada (la agenda interna la deja libre; online no)', () => {
    expect(computeOnlineSlots(query({ ranges: null })).slots).toEqual([]);
    expect(computeOnlineSlots(query({ ranges: [] })).slots).toEqual([]);
  });

  it('un día cerrado (festivo) o sin tramos no da huecos', () => {
    expect(starts(query({ isClosedDay: () => true }))).toEqual([]);
    expect(
      starts(
        query({ ranges: [{ weekday: 2, startMinute: 540, endMinute: 720 }] }),
      ),
    ).toEqual([]);
  });

  it('las citas y bloqueos ocupan: nunca un hueco que se solape', () => {
    const q = query({
      providers: [
        {
          providerId: 'p1',
          busy: [
            {
              start: at('2026-11-23T09:30:00'),
              end: at('2026-11-23T10:15:00'),
            },
          ],
        },
      ],
    });
    // 9:00 cabe (termina 9:30); 9:30 y 10:00 se solapan; 10:15 no está
    // alineado al paso de 30 → 10:30.
    expect(starts(q)).toEqual(['13:00', '14:30', '15:00', '15:30']);
  });

  it('el primer inicio tras una cita se alinea al paso en hora de PARED', () => {
    const q = query({
      stepMinutes: 15,
      providers: [
        {
          providerId: 'p1',
          busy: [
            {
              start: at('2026-11-23T09:00:00'),
              end: at('2026-11-23T09:05:00'),
            },
          ],
        },
      ],
    });
    expect(starts(q)[0]).toBe('13:15'); // 9:15 local
  });

  it('antelación mínima: nada antes de ahora + minLeadMinutes', () => {
    const q = query({
      now: at('2026-11-23T08:10:00'),
      minLeadMinutes: 120, // nada antes de las 10:10 → 10:30
    });
    expect(starts(q)).toEqual(['14:30', '15:00', '15:30']);
  });

  it('antelación máxima: nada que empiece después de ahora + maxAdvanceDays', () => {
    const q = query({
      now: at('2026-11-22T10:00:00'),
      minLeadMinutes: 0,
      maxAdvanceDays: 1, // hasta el lunes 10:00
    });
    expect(starts(q)).toEqual(['13:00', '13:30', '14:00']);
  });

  it('cruza con el horario del profesional en la sede (DX-233)', () => {
    const q = query({
      providers: [
        {
          providerId: 'p1',
          busy: [],
          rangesOn: () => [
            { startMinute: 10 * 60 + 30, endMinute: 11 * 60 + 30 },
          ],
        },
      ],
    });
    expect(starts(q)).toEqual(['14:30', '15:00']);
  });

  it('las citas del paciente identificado también ocupan', () => {
    const q = query({
      patientBusy: [
        { start: at('2026-11-23T09:00:00'), end: at('2026-11-23T11:00:00') },
      ],
    });
    expect(starts(q)).toEqual(['15:00', '15:30']);
  });

  it('varios profesionales: cada inicio una vez, con el primero libre en el orden recibido', () => {
    const q = query({
      providers: [
        {
          providerId: 'p1',
          busy: [
            {
              start: at('2026-11-23T09:00:00'),
              end: at('2026-11-23T11:00:00'),
            },
          ],
        },
        { providerId: 'p2', busy: [] },
      ],
    });
    const slots = computeOnlineSlots(q).slots;
    expect(slots.map((s) => s.providerId)).toEqual([
      'p2',
      'p2',
      'p2',
      'p2',
      'p1',
      'p1',
    ]);
    expect(new Set(slots.map((s) => s.start.getTime())).size).toBe(6);
  });

  it('respeta el tope y lo indica', () => {
    const result = computeOnlineSlots(query({ limit: 2 }));
    expect(result.slots).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('clampOnlineDays', () => {
  const now = at('2026-11-20T08:00:00');

  it('no empieza antes de hoy ni pasa de la antelación máxima', () => {
    expect(clampOnlineDays('2026-11-01', 7, TZ, now, 60)).toEqual({
      fromDay: '2026-11-20',
      toDay: '2026-11-26',
    });
    expect(clampOnlineDays('2026-11-20', 14, TZ, now, 3)).toEqual({
      fromDay: '2026-11-20',
      toDay: '2026-11-23',
    });
  });

  it('una ventana fuera de la antelación máxima no da días', () => {
    expect(clampOnlineDays('2027-03-01', 7, TZ, now, 60)).toBeNull();
  });

  it('como mucho 14 días por consulta', () => {
    expect(clampOnlineDays('2026-11-20', 40, TZ, now, 60)?.toDay).toBe(
      '2026-12-03',
    );
  });
});

describe('computeOnlineSlots con sillones (DX-583)', () => {
  const busy = (from: string, to: string) => ({
    start: at(`2026-11-23T${from}:00`),
    end: at(`2026-11-23T${to}:00`),
  });

  it('sin sillones (lista vacía) no cambia nada', () => {
    expect(starts(query({ chairBusy: [] }))).toEqual(starts(query()));
  });

  it('con un solo sillón, nunca un hueco en el que está ocupado (también un solape parcial)', () => {
    // Ocupado 9:45–10:30: caen 9:30 (termina 10:00) y 10:00.
    expect(starts(query({ chairBusy: [[busy('09:45', '10:30')]] }))).toEqual([
      '13:00',
      '14:30',
      '15:00',
      '15:30',
    ]);
  });

  it('con dos sillones basta con que uno esté libre', () => {
    expect(
      starts(
        query({
          chairBusy: [[busy('09:00', '12:00')], [busy('10:00', '11:00')]],
        }),
      ),
    ).toEqual(['13:00', '13:30', '15:00', '15:30']);
  });

  it('todos los sillones ocupados todo el día: ningún hueco aunque el profesional esté libre', () => {
    expect(
      starts(
        query({
          chairBusy: [[busy('09:00', '12:00')], [busy('08:00', '13:00')]],
        }),
      ),
    ).toEqual([]);
  });
});
