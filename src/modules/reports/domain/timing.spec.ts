import {
  availableMinutes,
  buildOccupancy,
  classifyTiming,
  EMPTY_TIMING_AGGREGATE,
  exceedsPlanned,
  mondayOf,
  percentileCont,
  round1,
  TIMING_THRESHOLDS,
  timingDefinitions,
  timingFigures,
  weeksOf,
  type ProviderLocationCapacity,
} from './timing';

// DX-275: reglas puras de «Tiempos». Sede en Caracas (UTC−4, sin horario de
// verano): las 09:00 de pared son las 13:00Z.
const at = (iso: string) => new Date(iso);
const min = (base: string, minutes: number) =>
  new Date(at(base).getTime() + minutes * 60_000);

const START = '2026-03-02T13:00:00.000Z'; // lunes 02/03, 09:00 en Caracas
const END = '2026-03-02T13:30:00.000Z';

function marks(
  arrived: number | null,
  seated: number | null,
  ready: number | null,
) {
  return {
    start: at(START),
    end: at(END),
    arrivedAt: arrived === null ? null : min(START, arrived),
    seatedAt: seated === null ? null : min(START, seated),
    readyForCheckoutAt: ready === null ? null : min(START, ready),
  };
}

describe('classifyTiming (DX-275)', () => {
  it('llega tarde: la espera cuenta desde la llegada; retraso y duración reales', () => {
    expect(classifyTiming(marks(10, 25, 65))).toEqual({
      kind: 'MEASURED',
      waitMinutes: 15,
      startDelayMinutes: 25,
      durationMinutes: 40,
      plannedMinutes: 30,
    });
  });

  it('llega antes de su hora: la espera cuenta desde la hora programada', () => {
    expect(classifyTiming(marks(-20, 5, 35))).toMatchObject({
      kind: 'MEASURED',
      waitMinutes: 5,
      startDelayMinutes: 5,
    });
  });

  it('se le sienta antes de su hora: espera 0 y retraso negativo (adelanto)', () => {
    expect(classifyTiming(marks(-20, -10, 20))).toMatchObject({
      kind: 'MEASURED',
      waitMinutes: 0,
      startDelayMinutes: -10,
      durationMinutes: 30,
    });
  });

  it('sin alguna de las tres horas: WITHOUT_TIMES, sin cifras', () => {
    for (const m of [
      marks(null, null, null),
      marks(0, null, null),
      marks(0, 5, null),
    ]) {
      expect(classifyTiming(m)).toEqual({
        kind: 'WITHOUT_TIMES',
        waitMinutes: null,
        startDelayMinutes: null,
        durationMinutes: null,
        plannedMinutes: 30,
      });
    }
  });

  it('incoherentes: cada umbral, en su borde exacto y un minuto después', () => {
    const t = TIMING_THRESHOLDS;
    // Espera de 240 min exactos vale; 241, no.
    expect(classifyTiming(marks(0, t.maxWaitMinutes, 300)).kind).toBe(
      'MEASURED',
    );
    expect(classifyTiming(marks(0, t.maxWaitMinutes + 1, 300)).kind).toBe(
      'INCOHERENT',
    );
    // Sentado 12 h antes de la hora (llegó antes aún): borde; 12 h y 1 min, no.
    expect(classifyTiming(marks(-800, -720, -700)).kind).toBe('MEASURED');
    expect(classifyTiming(marks(-800, -721, -700)).kind).toBe('INCOHERENT');
    // Duración: 1 min vale, 30 s no; 8 h vale, 8 h y 1 min no.
    expect(classifyTiming(marks(0, 0, 1)).kind).toBe('MEASURED');
    expect(classifyTiming(marks(0, 0, 0.5)).kind).toBe('INCOHERENT');
    expect(classifyTiming(marks(0, 0, 480)).kind).toBe('MEASURED');
    expect(classifyTiming(marks(0, 0, 481)).kind).toBe('INCOHERENT');
  });

  it('horas fuera de orden (la BD lo impide; la regla también): INCOHERENT', () => {
    expect(classifyTiming(marks(10, 5, 40)).kind).toBe('INCOHERENT');
    expect(classifyTiming(marks(0, 10, 5)).kind).toBe('INCOHERENT');
  });
});

describe('percentileCont (la referencia de percentile_cont)', () => {
  it('interpola entre vecinos: p90 de 1..10 = 9,1', () => {
    expect(percentileCont([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 0.9)).toBeCloseTo(
      9.1,
      10,
    );
  });

  it('casos conocidos: un valor, dos valores, p0, p100 y vacío', () => {
    expect(percentileCont([7], 0.9)).toBe(7);
    expect(percentileCont([0, 10], 0.9)).toBeCloseTo(9, 10);
    expect(percentileCont([3, 1, 2], 0)).toBe(1);
    expect(percentileCont([3, 1, 2], 1)).toBe(3);
    expect(percentileCont([], 0.9)).toBeNull();
  });

  it('p90 de 15 esperas: posición 12,6 entre el 13.º y el 14.º valor', () => {
    const waits = [0, 2, 3, 5, 5, 8, 10, 12, 15, 18, 20, 25, 30, 45, 60];
    // (15 − 1) · 0,9 = 12,6 → 30 + 0,6 · (45 − 30) = 39.
    expect(percentileCont(waits, 0.9)).toBeCloseTo(39, 10);
  });
});

describe('timingFigures y el aviso por tipo', () => {
  it('redondea a 1 decimal y calcula real frente a programada', () => {
    const f = timingFigures({
      ...EMPTY_TIMING_AGGREGATE,
      completed: 12,
      measured: 10,
      withoutTimes: 1,
      incoherent: 1,
      waitAvg: 12.345,
      waitP90: 30.06,
      startDelayAvg: -0.04,
      startDelayP90: 8,
      durationAvg: 37.5,
      durationP90: 50,
      plannedAvg: 30,
    });
    expect(f).toEqual({
      completed: 12,
      measured: 10,
      withoutTimes: 1,
      incoherent: 1,
      waitAvgMinutes: 12.3,
      waitP90Minutes: 30.1,
      startDelayAvgMinutes: 0,
      startDelayP90Minutes: 8,
      durationAvgMinutes: 37.5,
      durationP90Minutes: 50,
      plannedAvgMinutes: 30,
      durationVsPlannedPercent: 25,
    });
    expect(Object.is(round1(-0.04), 0)).toBe(true);
  });

  it('sin citas medidas: cifras null', () => {
    expect(timingFigures(EMPTY_TIMING_AGGREGATE)).toMatchObject({
      completed: 0,
      waitAvgMinutes: null,
      durationVsPlannedPercent: null,
    });
  });

  const figures = (measured: number, durationAvg: number) =>
    timingFigures({
      ...EMPTY_TIMING_AGGREGATE,
      completed: measured,
      measured,
      durationAvg,
      plannedAvg: 30,
    });

  it('avisa con > 20 % en ≥ 10 citas medidas; nunca sin tipo', () => {
    expect(exceedsPlanned(figures(10, 36.3), true)).toBe(true); // +21 %
    expect(exceedsPlanned(figures(10, 36), true)).toBe(false); // +20 % justo
    expect(exceedsPlanned(figures(9, 45), true)).toBe(false); // pocas citas
    expect(exceedsPlanned(figures(50, 45), false)).toBe(false); // sin tipo
  });
});

describe('semanas (lunes a domingo, recortadas al período)', () => {
  it('mondayOf: domingo y lunes', () => {
    expect(mondayOf('2026-03-08')).toBe('2026-03-02'); // domingo
    expect(mondayOf('2026-03-02')).toBe('2026-03-02');
    expect(mondayOf('2026-03-04')).toBe('2026-03-02');
  });

  it('weeksOf: primera y última recortadas', () => {
    expect(weeksOf({ from: '2026-03-04', to: '2026-03-17' })).toEqual([
      { weekStart: '2026-03-02', from: '2026-03-04', to: '2026-03-08' },
      { weekStart: '2026-03-09', from: '2026-03-09', to: '2026-03-15' },
      { weekStart: '2026-03-16', from: '2026-03-16', to: '2026-03-17' },
    ]);
  });
});

describe('ocupación con horario, excepciones, festivos y bloqueos', () => {
  // Lunes a viernes de 08:00 a 12:00 (240 min al día) en Caracas.
  const base: ProviderLocationCapacity = {
    providerId: 'dra-1',
    locationId: 'sede-1',
    timeZone: 'America/Caracas',
    ranges: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      startMinute: 8 * 60,
      endMinute: 12 * 60,
    })),
    overrides: new Map(),
    blocks: [],
    closures: [],
    holidays: [],
  };

  it('una semana completa: 5 × 240 = 1200 min', () => {
    expect(availableMinutes(base, '2026-03-02', '2026-03-08')).toBe(1200);
  });

  it('resta un bloqueo (vacaciones el martes 10:00–12:00), un cierre de la sede (el miércoles entero), un festivo (jueves) y aplica la excepción del viernes (solo 08:00–09:00)', () => {
    const capacity: ProviderLocationCapacity = {
      ...base,
      blocks: [
        // martes 03/03 10:00–12:00 en Caracas = 14:00Z–16:00Z
        {
          start: at('2026-03-03T14:00:00.000Z'),
          end: at('2026-03-03T16:00:00.000Z'),
        },
      ],
      closures: [
        // miércoles 04/03 todo el día
        {
          start: at('2026-03-04T04:00:00.000Z'),
          end: at('2026-03-05T04:00:00.000Z'),
        },
      ],
      holidays: [{ date: '2026-03-05', recurring: false }],
      overrides: new Map([
        ['2026-03-06', [{ startMinute: 480, endMinute: 540 }]],
      ]),
    };
    // lunes 240 + martes 120 + miércoles 0 + jueves 0 + viernes 60 = 420
    expect(availableMinutes(capacity, '2026-03-02', '2026-03-08')).toBe(420);
  });

  it('el festivo recurrente cierra ese día cada año y manda sobre la excepción', () => {
    const capacity: ProviderLocationCapacity = {
      ...base,
      holidays: [{ date: '2020-03-02', recurring: true }],
      overrides: new Map([
        ['2026-03-02', [{ startMinute: 480, endMinute: 720 }]],
      ]),
    };
    expect(availableMinutes(capacity, '2026-03-02', '2026-03-02')).toBe(0);
  });

  it('buildOccupancy: por semana y total, libres y ocupación = atendidas ÷ disponibles', () => {
    const { professionals, totals } = buildOccupancy(
      { from: '2026-03-02', to: '2026-03-15' },
      [base],
      [
        {
          providerId: 'dra-1',
          weekStart: '2026-03-02',
          booked: 900,
          attended: 600,
          noShow: 60,
        },
        {
          providerId: 'dra-1',
          weekStart: '2026-03-09',
          booked: 1300,
          attended: 1300,
          noShow: 0,
        },
        // Un profesional sin horario con citas: sale, sin ocupación.
        {
          providerId: 'dr-2',
          weekStart: '2026-03-09',
          booked: 90,
          attended: 90,
          noShow: 0,
        },
      ],
    );
    const dra = professionals.find((p) => p.providerId === 'dra-1')!;
    expect(dra).toMatchObject({
      hasSchedule: true,
      availableMinutes: 2400,
      bookedMinutes: 2200,
      attendedMinutes: 1900,
      noShowMinutes: 60,
      // Libres por semana, sumados: 300 + 0 (la segunda, citada de más).
      freeMinutes: 300,
      occupancyPercent: 79.2,
    });
    expect(dra.weeks).toEqual([
      {
        weekStart: '2026-03-02',
        from: '2026-03-02',
        to: '2026-03-08',
        availableMinutes: 1200,
        bookedMinutes: 900,
        attendedMinutes: 600,
        noShowMinutes: 60,
        freeMinutes: 300,
        occupancyPercent: 50,
      },
      {
        weekStart: '2026-03-09',
        from: '2026-03-09',
        to: '2026-03-15',
        availableMinutes: 1200,
        bookedMinutes: 1300,
        attendedMinutes: 1300,
        // Citado por encima del horario: libres 0, ocupación > 100 %.
        freeMinutes: 0,
        noShowMinutes: 0,
        occupancyPercent: 108.3,
      },
    ]);
    const dr2 = professionals.find((p) => p.providerId === 'dr-2')!;
    expect(dr2).toMatchObject({
      hasSchedule: false,
      availableMinutes: 0,
      occupancyPercent: null,
    });
    expect(totals).toEqual({
      availableMinutes: 2400,
      bookedMinutes: 2290,
      attendedMinutes: 1990,
      noShowMinutes: 60,
      freeMinutes: 300,
      occupancyPercent: 82.9,
    });
  });

  it('dos sedes del mismo profesional suman su capacidad', () => {
    const { professionals } = buildOccupancy(
      { from: '2026-03-02', to: '2026-03-08' },
      [base, { ...base, locationId: 'sede-2' }],
      [],
    );
    expect(professionals[0].availableMinutes).toBe(2400);
  });
});

describe('definiciones', () => {
  it('una por cifra, con los umbrales en el texto', () => {
    const defs = timingDefinitions();
    expect(defs.map((d) => d.key)).toEqual([
      'completed',
      'withoutTimes',
      'incoherent',
      'wait',
      'startDelay',
      'duration',
      'planned',
      'durationVsPlanned',
      'typeOverrun',
      'availableMinutes',
      'bookedMinutes',
      'attendedMinutes',
      'noShowMinutes',
      'freeMinutes',
      'occupancy',
    ]);
    const incoherent = defs.find((d) => d.key === 'incoherent')!;
    expect(incoherent.howItIsCalculated).toContain('240 min');
    expect(incoherent.howItIsCalculated).toContain('12 h');
    expect(incoherent.howItIsCalculated).toContain('8 h');
    expect(
      defs.find((d) => d.key === 'typeOverrun')!.howItIsCalculated,
    ).toContain('al menos 10 citas');
  });
});
