import { capacityMinutes, openMinutes } from './open-minutes';

// Horario por defecto del registro: lun-vie 9-13 y 15-19, sáb 9-13.
const DEFAULT_WEEK = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startMinute: 9 * 60, endMinute: 13 * 60 },
  { weekday, startMinute: 15 * 60, endMinute: 19 * 60 },
]);
const WEEK = [
  ...DEFAULT_WEEK,
  { weekday: 6, startMinute: 540, endMinute: 780 },
];
const BOGOTA = 'America/Bogota';

describe('openMinutes (DX-014)', () => {
  it('suma los tramos de cada día del período según su día de la semana', () => {
    // 2026-10-19 lunes … 2026-10-25 domingo: 5 × 480 + 240 (sábado) + 0.
    expect(
      openMinutes({
        from: '2026-10-19',
        to: '2026-10-25',
        timeZone: BOGOTA,
        ranges: WEEK,
        closures: [],
      }),
    ).toBe(5 * 480 + 240);
  });

  it('tramos que se pisan cuentan una sola vez', () => {
    expect(
      openMinutes({
        from: '2026-10-19',
        to: '2026-10-19',
        timeZone: BOGOTA,
        ranges: [
          { weekday: 1, startMinute: 540, endMinute: 720 },
          { weekday: 1, startMinute: 660, endMinute: 780 },
        ],
        closures: [],
      }),
    ).toBe(240);
  });

  it('descuenta los cierres de toda la sede que caen en horario', () => {
    // Lunes 2026-10-19, cierre de 12:00 a 16:00 (Bogotá = UTC-5): quita
    // 12-13 y 15-16 → 480 − 120.
    expect(
      openMinutes({
        from: '2026-10-19',
        to: '2026-10-19',
        timeZone: BOGOTA,
        ranges: WEEK,
        closures: [
          {
            start: new Date('2026-10-19T17:00:00Z'),
            end: new Date('2026-10-19T21:00:00Z'),
          },
        ],
      }),
    ).toBe(360);
  });

  it('cierres solapados o fuera del período no descuentan dos veces ni de más', () => {
    expect(
      openMinutes({
        from: '2026-10-19',
        to: '2026-10-20',
        timeZone: BOGOTA,
        ranges: WEEK,
        closures: [
          // Todo el lunes, dos veces (vacaciones registradas por duplicado).
          {
            start: new Date('2026-10-19T05:00:00Z'),
            end: new Date('2026-10-20T05:00:00Z'),
          },
          {
            start: new Date('2026-10-19T10:00:00Z'),
            end: new Date('2026-10-19T23:00:00Z'),
          },
          // Un cierre del domingo anterior: fuera del período.
          {
            start: new Date('2026-10-18T14:00:00Z'),
            end: new Date('2026-10-18T18:00:00Z'),
          },
        ],
      }),
    ).toBe(480);
  });

  it('usa la zona de la sede (Madrid, con cambio de hora el 25/10/2026)', () => {
    // Domingo 25/10 cerrado; el lunes 26 abre 9-13 hora de Madrid (UTC+1 ya).
    const madrid = openMinutes({
      from: '2026-10-26',
      to: '2026-10-26',
      timeZone: 'Europe/Madrid',
      ranges: [{ weekday: 1, startMinute: 540, endMinute: 780 }],
      closures: [
        // 9:00-10:00 de Madrid = 08:00-09:00 UTC.
        {
          start: new Date('2026-10-26T08:00:00Z'),
          end: new Date('2026-10-26T09:00:00Z'),
        },
      ],
    });
    expect(madrid).toBe(180);
  });

  it('sin tramos (todo cerrado) da 0', () => {
    expect(
      openMinutes({
        from: '2026-10-01',
        to: '2026-10-31',
        timeZone: BOGOTA,
        ranges: [],
        closures: [],
      }),
    ).toBe(0);
  });
});

describe('capacityMinutes (BE-042, DX-305)', () => {
  // Lunes 2026-10-19 … viernes 2026-10-23.
  const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
  }));
  const MORNINGS_9_TO_13 = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: 9 * 60,
    endMinute: 13 * 60,
  }));
  const week = { from: '2026-10-19', to: '2026-10-23', timeZone: BOGOTA };
  const provider = (
    ranges: typeof WEEKDAYS_9_TO_17,
    extra: Partial<Parameters<typeof capacityMinutes>[0]['providers'][0]> = {},
  ) => ({ ranges, overrides: new Map(), blocks: [], ...extra });

  it('sin profesionales con horario en la sede no hay capacidad (null)', () => {
    expect(
      capacityMinutes({ ...week, providers: [], closures: [] }),
    ).toBeNull();
  });

  it('suma el horario de cada profesional: dos en paralelo, el doble', () => {
    const one = capacityMinutes({
      ...week,
      providers: [provider(WEEKDAYS_9_TO_17)],
      closures: [],
    });
    expect(one).toBe(5 * 480);
    expect(
      capacityMinutes({
        ...week,
        providers: [provider(WEEKDAYS_9_TO_17), provider(WEEKDAYS_9_TO_17)],
        closures: [],
      }),
    ).toBe(2 * 5 * 480);
  });

  it('un profesional de media jornada aporta la mitad', () => {
    expect(
      capacityMinutes({
        ...week,
        providers: [provider(WEEKDAYS_9_TO_17), provider(MORNINGS_9_TO_13)],
        closures: [],
      }),
    ).toBe(5 * 480 + 5 * 240);
  });

  it('la excepción de un día manda sobre el semanal (sin tramos = no trabaja)', () => {
    expect(
      capacityMinutes({
        ...week,
        providers: [
          provider(WEEKDAYS_9_TO_17, {
            overrides: new Map([
              ['2026-10-20', []],
              ['2026-10-21', [{ startMinute: 600, endMinute: 660 }]],
            ]),
          }),
        ],
        closures: [],
      }),
    ).toBe(3 * 480 + 60);
  });

  it('descuenta sus bloqueos y los cierres de la sede, sin restar dos veces', () => {
    // Lunes: vacaciones del profesional todo el día; martes: cierre de la
    // sede 9-11 y un bloqueo suyo 10-12 que se pisan (9-12 = 180 min).
    expect(
      capacityMinutes({
        ...week,
        providers: [
          provider(WEEKDAYS_9_TO_17, {
            blocks: [
              {
                start: new Date('2026-10-19T05:00:00Z'),
                end: new Date('2026-10-20T05:00:00Z'),
              },
              {
                start: new Date('2026-10-20T15:00:00Z'),
                end: new Date('2026-10-20T17:00:00Z'),
              },
            ],
          }),
        ],
        closures: [
          {
            start: new Date('2026-10-20T14:00:00Z'),
            end: new Date('2026-10-20T16:00:00Z'),
          },
        ],
      }),
    ).toBe(5 * 480 - 480 - 180);
  });
});
