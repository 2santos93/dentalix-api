import {
  buildMetrics,
  fillsSlot,
  isoWeekStart,
  matchRecoveredSlots,
  slotWeek,
  valueAttribution,
  weeksOfPeriod,
  type FillCandidate,
  type FreedSlot,
} from './recovered-slots';

// Sede en America/Caracas (UTC−4 fijo): las 09:00 de la sede son las 13:00 UTC.
const ZONE = 'America/Caracas';
const at = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(...ymd(day), h + 4, m));
};
function ymd(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y, m - 1, d];
}

const DAY = '2026-10-07';
const PROVIDER = 'prov-1';
const LOCATION = 'loc-1';

function slot(overrides: Partial<FreedSlot> = {}): FreedSlot {
  return {
    id: 'slot-1',
    locationId: LOCATION,
    providerId: PROVIDER,
    start: at(DAY, '11:00'),
    end: at(DAY, '11:30'),
    freedAt: at(DAY, '09:00'),
    timeZone: ZONE,
    ...overrides,
  };
}

function candidate(overrides: Partial<FillCandidate> = {}): FillCandidate {
  return {
    slotId: 'slot-1',
    appointmentId: 'appt-1',
    locationId: LOCATION,
    providerId: PROVIDER,
    start: at(DAY, '11:00'),
    end: at(DAY, '11:30'),
    arrivedAt: at(DAY, '09:40'),
    byList: false,
    ...overrides,
  };
}

const NO_VALUES = new Map<string, { currency: string; amount: number }[]>();

describe('Huecos recuperados: emparejamiento hueco ↔ relleno (DX-436)', () => {
  it('el ejemplo del ticket: cancelado a las 9:00 y ocupado a las 9:40 por un pendiente', () => {
    const [o] = matchRecoveredSlots([slot()], [candidate({ byList: true })]);
    expect(o).toMatchObject({
      fill: 'FILLED',
      freedMinutes: 30,
      recoveredMinutes: 30,
      minutesToFill: 40,
      byList: true,
      fillerIds: ['appt-1'],
    });
    const m = buildMetrics([o], [], [], NO_VALUES, valueAttribution([o]));
    expect(m).toMatchObject({
      freedSlots: 1,
      filledSlots: 1,
      partiallyFilledSlots: 0,
      filledByListSlots: 1,
      fillRate: 1,
      filledWithin30MinRate: 0,
      filledWithin24hRate: 1,
      meanMinutesToFill: 40,
    });
  });

  it('una cita que ocupa solo parte del hueco es un relleno parcial con sus minutos', () => {
    const [o] = matchRecoveredSlots(
      [slot({ end: at(DAY, '12:00') })],
      [candidate({ start: at(DAY, '11:15'), end: at(DAY, '11:45') })],
    );
    expect(o).toMatchObject({
      fill: 'PARTIAL',
      freedMinutes: 60,
      recoveredMinutes: 30,
    });
    const m = buildMetrics([o], [], [], NO_VALUES, new Set());
    expect(m).toMatchObject({
      filledSlots: 0,
      partiallyFilledSlots: 1,
      recoveredMinutes: 30,
      fillRate: 1,
    });
  });

  it('dos citas que juntas cubren el hueco lo rellenan del todo; el tiempo es el de la primera', () => {
    const [o] = matchRecoveredSlots(
      [slot({ end: at(DAY, '12:00') })],
      [
        candidate({
          appointmentId: 'b',
          start: at(DAY, '11:30'),
          end: at(DAY, '12:00'),
          arrivedAt: at(DAY, '10:00'),
        }),
        candidate({ appointmentId: 'a', arrivedAt: at(DAY, '09:10') }),
      ],
    );
    expect(o).toMatchObject({
      fill: 'FILLED',
      recoveredMinutes: 60,
      minutesToFill: 10,
      fillerIds: ['a', 'b'],
    });
  });

  it('un sobrecupo creado antes de la cancelación no cuenta', () => {
    const [o] = matchRecoveredSlots(
      [slot()],
      [candidate({ arrivedAt: at(DAY, '08:59') })],
    );
    expect(o.fill).toBe('OPEN');
    expect(o.minutesToFill).toBeNull();
    // Llegó en el mismo instante de la liberación: tampoco es posterior.
    expect(fillsSlot(slot(), candidate({ arrivedAt: at(DAY, '09:00') }))).toBe(
      false,
    );
  });

  it('una cita que llega cuando el hueco ya terminó no lo recupera', () => {
    expect(fillsSlot(slot(), candidate({ arrivedAt: at(DAY, '11:30') }))).toBe(
      false,
    );
    expect(fillsSlot(slot(), candidate({ arrivedAt: at(DAY, '11:29') }))).toBe(
      true,
    );
  });

  it('una cita de otro profesional (u otra sede) no rellena el hueco', () => {
    const outcomes = matchRecoveredSlots(
      [slot()],
      [
        candidate({ appointmentId: 'x', providerId: 'prov-2' }),
        candidate({ appointmentId: 'y', locationId: 'loc-2' }),
      ],
    );
    expect(outcomes[0].fill).toBe('OPEN');
  });

  it('una cita que solo roza el borde (termina cuando empieza el hueco) no se solapa', () => {
    expect(
      fillsSlot(
        slot(),
        candidate({ start: at(DAY, '10:30'), end: at(DAY, '11:00') }),
      ),
    ).toBe(false);
  });

  it('sin doble conteo: una cita que se solapa con dos huecos liberados de la misma hora cuenta una vez', () => {
    // La 11:00 se liberó dos veces (A a las 8:00; B, que la ocupó, a las 9:00)
    // y C llegó a las 9:40: rellena la liberación más reciente (B).
    const a = slot({ id: 'A', freedAt: at(DAY, '08:00') });
    const b = slot({ id: 'B', freedAt: at(DAY, '09:00') });
    const c = (slotId: string) => candidate({ slotId, appointmentId: 'C' });
    const outcomes = matchRecoveredSlots([a, b], [c('A'), c('B')]);
    const byId = new Map(outcomes.map((o) => [o.slot.id, o]));
    expect(byId.get('B')).toMatchObject({ fill: 'FILLED', minutesToFill: 40 });
    expect(byId.get('A')).toMatchObject({ fill: 'OPEN', recoveredMinutes: 0 });
    const m = buildMetrics(
      outcomes,
      [],
      [],
      new Map([['C', [{ currency: 'USD', amount: 80 }]]]),
      valueAttribution(outcomes),
    );
    expect(m.freedSlots).toBe(2);
    expect(m.filledSlots).toBe(1);
    expect(m.recoveredValue).toEqual([{ currency: 'USD', amount: 80 }]);
  });

  it('una cita larga que cubre dos huecos contiguos recupera los dos, y su valor se suma una vez', () => {
    const first = slot({ id: 'S1' });
    const second = slot({
      id: 'S2',
      start: at(DAY, '11:30'),
      end: at(DAY, '12:00'),
    });
    const long = (slotId: string) =>
      candidate({ slotId, appointmentId: 'L', end: at(DAY, '12:00') });
    const outcomes = matchRecoveredSlots(
      [first, second],
      [long('S1'), long('S2')],
    );
    expect(outcomes.map((o) => o.fill)).toEqual(['FILLED', 'FILLED']);
    const m = buildMetrics(
      outcomes,
      [],
      [],
      new Map([
        [
          'L',
          [
            { currency: 'USD', amount: 50 },
            { currency: 'VES', amount: 1000 },
          ],
        ],
      ]),
      valueAttribution(outcomes),
    );
    expect(m.recoveredValue).toEqual([
      { currency: 'USD', amount: 50 },
      { currency: 'VES', amount: 1000 },
    ]);
    expect(m.unvaluedRecoveredSlots).toBe(0);
  });

  it('el emparejamiento no depende del orden de entrada', () => {
    const slots = [
      slot({ id: 'A', freedAt: at(DAY, '08:00') }),
      slot({ id: 'B', freedAt: at(DAY, '09:00') }),
    ];
    const cands = [
      candidate({ slotId: 'A', appointmentId: 'C' }),
      candidate({ slotId: 'B', appointmentId: 'C' }),
      candidate({
        slotId: 'A',
        appointmentId: 'D',
        arrivedAt: at(DAY, '08:30'),
      }),
    ];
    const one = matchRecoveredSlots(slots, cands);
    const two = matchRecoveredSlots([...slots].reverse(), [...cands].reverse());
    expect(two).toEqual(one);
    // D (llegó a las 8:30, después de A y antes de B) rellena A; C, B.
    expect(one.map((o) => [o.slot.id, o.fillerIds])).toEqual([
      ['A', ['D']],
      ['B', ['C']],
    ]);
  });

  it('sin ítems ligados el hueco recuperado es «sin valorar»', () => {
    const outcomes = matchRecoveredSlots([slot()], [candidate()]);
    const m = buildMetrics(
      outcomes,
      [],
      [],
      NO_VALUES,
      valueAttribution(outcomes),
    );
    expect(m.unvaluedRecoveredSlots).toBe(1);
    expect(m.recoveredValue).toEqual([]);
  });
});

describe('Huecos recuperados: semanas y métricas (DX-436)', () => {
  it('la semana del hueco es la de su día civil en la zona de la sede', () => {
    // Domingo 11/10 a las 22:00 en Caracas = lunes 12/10 02:00 UTC: cuenta en
    // la semana del lunes 5, no en la del 12.
    const s = slot({
      start: new Date('2026-10-12T02:00:00Z'),
      end: new Date('2026-10-12T02:30:00Z'),
    });
    expect(slotWeek(s)).toBe('2026-10-05');
    expect(slotWeek({ ...s, timeZone: 'UTC' })).toBe('2026-10-12');
  });

  it('semanas ISO: el lunes de cada día y todas las semanas del período', () => {
    expect(isoWeekStart('2026-10-05')).toBe('2026-10-05');
    expect(isoWeekStart('2026-10-11')).toBe('2026-10-05');
    expect(isoWeekStart('2026-10-01')).toBe('2026-09-28');
    expect(weeksOfPeriod('2026-10-01', '2026-10-31')).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ]);
  });

  it('tasas: relleno sobre liberados, cancelación sobre agendadas, ofertas por desenlace', () => {
    const outcomes = matchRecoveredSlots(
      [
        slot({ id: 'S1' }),
        slot({ id: 'S2', start: at(DAY, '15:00'), end: at(DAY, '15:30') }),
      ],
      [candidate({ slotId: 'S1', arrivedAt: at(DAY, '09:20') })],
    );
    const m = buildMetrics(
      outcomes,
      [
        { providerId: PROVIDER, day: DAY, scheduled: 8, cancelled: 2 },
        { providerId: PROVIDER, day: '2026-10-08', scheduled: 2, cancelled: 0 },
      ],
      [
        { providerId: PROVIDER, day: DAY, outcome: 'ACCEPTED', count: 1 },
        { providerId: PROVIDER, day: DAY, outcome: 'DECLINED', count: 2 },
        { providerId: PROVIDER, day: DAY, outcome: 'UNANSWERED', count: 3 },
      ],
      NO_VALUES,
      valueAttribution(outcomes),
    );
    expect(m).toMatchObject({
      freedSlots: 2,
      freedMinutes: 60,
      filledSlots: 1,
      fillRate: 0.5,
      filledWithin30MinRate: 0.5,
      filledWithin24hRate: 0.5,
      meanMinutesToFill: 20,
      cancellationRate: 0.2,
      offers: { sent: 6, accepted: 1, declined: 2, unanswered: 3 },
    });
  });

  it('sin huecos ni citas: tasas null, no 0', () => {
    expect(buildMetrics([], [], [], NO_VALUES, new Set())).toMatchObject({
      fillRate: null,
      filledWithin30MinRate: null,
      filledWithin24hRate: null,
      meanMinutesToFill: null,
      cancellationRate: null,
    });
  });
});
